# Referência de Comandos do GSD Core

> Referência de comandos do GSD Core — sintaxe, flags, opções e exemplos para cada comando estável. Para detalhes sobre funcionalidades, consulte a [Referência de Funcionalidades](FEATURES.md); para tutoriais de fluxo de trabalho, consulte o [Guia do Usuário](USER-GUIDE.md); para o índice de documentação, consulte o [README](README.md).

---

## Sintaxe de Comandos

- **Claude Code / Copilot / OpenCode / Kilo:** `/gsd-command-name [args]` (forma com hífen)
- **Gemini CLI:** `/gsd:command-name [args]` (forma com dois-pontos — o Gemini agrupa comandos sob `gsd:`)
- **Codex:** `$gsd-command-name [args]`

As formas com hífen e com dois-pontos são *variações específicas do runtime para o mesmo comando*. Independente do runtime utilizado, o instalador escreve a forma correta no diretório de comandos do seu runtime.

---

## Meta-Skills de Namespace

Seis roteadores de namespace são incluídos como pontos de entrada de primeiro estágio na v1.40. Eles mantêm o custo de tokens da listagem antecipada de skills baixo (~120 tokens para 6 roteadores vs ~2.150 para uma listagem plana de 86 skills), enquanto toda a superfície permanece invocável diretamente. O modelo seleciona um namespace e então roteia para a sub-skill concreta. Consulte [#2792](https://github.com/open-gsd/gsd-core/issues/2792).

| Comando | Roteia para |
|---------|-------------|
| `/gsd-workflow` | Pipeline de fases — discuss / plan / execute / verify / phase / progress |
| `/gsd-project` | Ciclo de vida do projeto — milestones, auditorias, resumo |
| `/gsd-quality` | Portões de qualidade — revisão de código, debug, auditoria, segurança, eval, ui |
| `/gsd-context` | Inteligência da base de código — map, graphify, docs, learnings |
| `/gsd-manage` | Gerenciamento — config, workspace, workstreams, thread, update, ship, inbox |
| `/gsd-ideate` | Exploração e captura — explore, sketch, spike, spec, capture |

Os skills de namespace são **aditivos** — todo comando concreto existente (por exemplo, `/gsd-plan-phase`, `/gsd-code-review --fix`) ainda pode ser invocado diretamente.

---

## Comandos Principais de Fluxo de Trabalho

### `/gsd-new-project`

Inicializa um novo projeto com coleta aprofundada de contexto.

| Flag | Descrição |
|------|-----------|
| `--auto @file.md` | Extrai automaticamente a partir de um documento, sem perguntas interativas |

**Pré-requisitos:** Nenhum `.planning/PROJECT.md` existente
**Produz:** `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, `config.json`, `research/`, `CLAUDE.md`

```bash
/gsd-new-project                    # Modo interativo
/gsd-new-project --auto @prd.md     # Extração automática a partir de PRD
```

---

### `/gsd-onboard`

Guia o onboarding inicial de um código existente no GSD. O comando verifica o estado do repositório, encaminha com segurança por mapeamento da base de código, ingestão opcional de documentos, inicialização do projeto e cria um onboarding summary quando o planejamento existe.

| Flag | Descrição |
|------|-----------|
| `--fast` | Prefere o handoff leve `/gsd-map-codebase --fast`; um mapa completo ainda é necessário antes de `/gsd-new-project` |
| `--text` | Usa gates numerados em texto puro em vez de menus TUI |

**Pré-requisitos:** Repositório existente ou documentos de planejamento. Para projetos greenfield vazios, use `/gsd-new-project`.
**Produz:** `.planning/codebase/` via map-codebase, `.planning/` via new-project ou ingest-docs, e `.planning/onboarding/SUMMARY.md` após a configuração do projeto.

```bash
/gsd-onboard           # Onboarding brownfield guiado
/gsd-onboard --fast    # Usa primeiro o mapa leve e depois completa o mapa antes do setup do projeto
```

---

### `/gsd-workspace`

Gerencia workspaces do GSD — cria, lista ou remove ambientes de workspace isolados com cópias de repositório e diretórios `.planning/` independentes.

| Flag | Descrição |
|------|-----------|
| `--new` | Cria um novo workspace (use com `--name`, `--repos`, etc.) |
| `--list` | Lista os workspaces GSD ativos e seus status |
| `--remove <name>` | Remove um workspace e limpa as worktrees do git |
| `--name <name>` | Nome do workspace (usado com `--new`) |
| `--repos repo1,repo2` | Caminhos ou nomes de repositórios separados por vírgula (usado com `--new`) |
| `--path /target` | Diretório de destino (padrão: `~/gsd-workspaces/<name>`) |
| `--strategy worktree\|clone` | Estratégia de cópia (padrão: `worktree`) |
| `--branch <name>` | Branch para checkout (padrão: `workspace/<name>`) |
| `--auto` | Ignora perguntas interativas |

**Casos de uso:**
- Multi-repositório: trabalha em um subconjunto de repositórios com estado GSD isolado
- Isolamento de funcionalidade: `--repos .` cria uma worktree do repositório atual

**Produz:** `WORKSPACE.md`, `.planning/`, cópias de repositórios (worktrees ou clones)

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI
/gsd-workspace --new --name feature-b --repos . --strategy worktree  # Isolamento no mesmo repositório
/gsd-workspace --list
/gsd-workspace --remove feature-b
```

---

### `/gsd-discuss-phase`

Coleta contexto da fase por meio de perguntas adaptativas antes do planejamento.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `N` | Não | Número da fase (padrão: fase atual) |

| Flag | Descrição |
|------|-----------|
| `--all` | Ignora a seleção de área — discute todas as áreas cinzentas interativamente (sem avanço automático) |
| `--auto` | Seleciona automaticamente os padrões recomendados para todas as perguntas |
| `--batch` | Agrupa perguntas para entrada em lote em vez de uma por vez |
| `--analyze` | Adiciona análise de trade-offs durante a discussão |
| `--power` | Resposta em massa de perguntas baseada em arquivo a partir de um arquivo de respostas preparado |
| `--assumptions` | Expõe as suposições de implementação do Claude sobre a fase sem uma sessão interativa |

**Pré-requisitos:** `.planning/ROADMAP.md` existe
**Produz:** `{phase}-CONTEXT.md`, `{phase}-DISCUSSION-LOG.md` (trilha de auditoria)

```bash
/gsd-discuss-phase 1                # Discussão interativa para a fase 1
/gsd-discuss-phase 1 --all          # Discute todas as áreas cinzentas sem etapa de seleção
/gsd-discuss-phase 3 --auto         # Seleciona padrões automaticamente para a fase 3
/gsd-discuss-phase --batch          # Modo em lote para a fase atual
/gsd-discuss-phase 2 --analyze      # Discussão com análise de trade-offs
/gsd-discuss-phase 1 --power        # Respostas em massa a partir de arquivo
/gsd-discuss-phase 3 --assumptions  # Expõe as suposições do Claude antes do planejamento
```

---

### `/gsd-ui-phase`

Gera contrato de design de UI para fases frontend.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `N` | Não | Número da fase (padrão: fase atual) |

**Pré-requisitos:** `.planning/ROADMAP.md` existe, a fase tem trabalho de frontend/UI
**Produz:** `{phase}-UI-SPEC.md`

```bash
/gsd-ui-phase 2                     # Contrato de design para a fase 2
```

---

### `/gsd-plan-phase`

Pesquisa, planeja e verifica uma fase.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `N` | Não | Número da fase (padrão: próxima fase não planejada) |

| Flag | Descrição |
|------|-----------|
| `--auto` | Ignora confirmações interativas |
| `--research` | Força nova pesquisa mesmo que RESEARCH.md exista |
| `--skip-research` | Ignora a etapa de pesquisa de domínio |
| `--research-phase <N>` | Modo somente pesquisa: cria um agente pesquisador para a fase `<N>`, escreve RESEARCH.md e sai antes do planejador. Substitui o comando de pesquisa autônomo removido (#3042). |
| `--view` | Modificador somente visualização: quando usado com `--research-phase`, imprime o RESEARCH.md existente no stdout e sai (sem criar agente). |
| `--gaps` | Modo de fechamento de lacunas (lê VERIFICATION.md, ignora pesquisa) |
| `--skip-verify` | Ignora o loop de verificação do verificador de plano |
| `--prd <file>` | Usa um arquivo PRD em vez de discuss-phase para contexto |
| `--ingest <path-or-glob>` | Usa arquivo(s) ADR em vez de discuss-phase para síntese de contexto |
| `--ingest-format <auto\|nygard\|madr\|narrative>` | Substituição opcional do formato do parser ADR para `--ingest` |
| `--reviews` | Replaneja com feedback de revisão cross-AI do REVIEWS.md |
| `--bounce` | Executa validação de bounce externo após o planejamento (usa `workflow.plan_bounce_script`) |
| `--skip-bounce` | Ignora o bounce do plano mesmo se habilitado na configuração |
| `--mvp` | Modo MVP vertical — o planejador organiza tarefas como fatias de funcionalidade (UI→API→DB) em vez de camadas horizontais. Na Fase 1 de um novo projeto sem resumos de fases anteriores, também emite `SKELETON.md` (Walking Skeleton). Pode ser persistido em uma fase via `**Mode:** mvp` no ROADMAP.md, o que aplica `--mvp` automaticamente sem a flag. |
| `--tdd` | Modo TDD — o planejador aplica `type: tdd` a tarefas elegíveis que adicionam comportamento, fazendo com que cada uma comece com um teste falho. Combina com `--mvp`: `--mvp --tdd` produz fatias verticais onde cada tarefa que adiciona comportamento começa vermelho-verde. |

**Pré-requisitos:** `.planning/ROADMAP.md` existe
**Produz:** `{phase}-RESEARCH.md`, `{phase}-{N}-PLAN.md`, `{phase}-VALIDATION.md`; `{phase}/SKELETON.md` quando o modo Walking Skeleton é ativado

**Modo somente pesquisa (`--research-phase <N>`):**
- Sem modificador: solicita `update / view / skip` se RESEARCH.md já existir.
- Com `--research`: atualização forçada — cria o agente pesquisador novamente incondicionalmente, sem prompt.
- Com `--view`: imprime o RESEARCH.md existente no stdout, sem criar agente. Apresenta erro se RESEARCH.md estiver ausente.

**Portão de Legitimidade de Pacotes (v1.42.1):**
Quando o pesquisador recomenda pacotes externos, executa `slopcheck install <pkg> --json` em cada um e escreve uma tabela `## Package Legitimacy Audit` no RESEARCH.md com os campos Registry, Age, Downloads, Source Repo e veredicto do slopcheck. Veredictos:

- `[SLOP]` — pacote removido do RESEARCH.md completamente; nunca chega ao planejador
- `[SUS]` — pacote sinalizado; o planejador insere `checkpoint:human-verify` antes da tarefa de instalação
- `[OK]` — pacote aprovado; nenhum checkpoint adicionado

Pacotes obtidos via WebSearch são marcados como `[ASSUMED]` (não `[VERIFIED]`) e tratados da mesma forma que `[SUS]` — recebem um checkpoint humano antes da instalação. Se `slopcheck` não puder ser instalado, cada pacote recomendado é marcado como `[ASSUMED]` e bloqueado.

Consulte o [Portão de Legitimidade de Pacotes no Guia do Usuário](USER-GUIDE.md#package-legitimacy-gate-v1421) para o formato completo do checkpoint, tabela de veredictos e solução de problemas.

```bash
/gsd-plan-phase 1                              # Pesquisa + plano + verificação da fase 1
/gsd-plan-phase 3 --skip-research              # Planejar sem pesquisa (domínio familiar)
/gsd-plan-phase --auto                         # Planejamento não interativo
/gsd-plan-phase 1 --bounce                     # Plano + validação de bounce externo
/gsd-plan-phase 2 --ingest docs/adr/0010.md   # Caminho expresso via ADR para síntese de contexto
/gsd-plan-phase 2 --ingest 'docs/adr/00*.md' --ingest-format auto
/gsd-plan-phase --research-phase 4             # Somente pesquisa na fase 4 (solicita se RESEARCH.md existir)
/gsd-plan-phase --research-phase 4 --view      # Imprime RESEARCH.md existente, sem criar agente
/gsd-plan-phase --research-phase 4 --research  # Força atualização da pesquisa, sem prompt
/gsd-plan-phase 1 --mvp                        # Plano em fatias verticais para a fase 1
/gsd-plan-phase 1 --mvp --tdd                  # Fatias verticais + teste falho por tarefa que adiciona comportamento
```

---

### `/gsd-plan-review-convergence`

Loop de convergência de planos cross-AI — replaneja com feedback de revisão até que não restem preocupações de nível HIGH. Executa ciclos `plan-phase → review → replan → re-review` (máximo de 3 ciclos por padrão). Cria agentes isolados para planejamento e revisão; o orquestrador controla o loop, contagem de preocupações HIGH, detecção de estagnação e escalação.

| Argumento / Flag | Obrigatório | Descrição |
|------------------|-------------|-----------|
| `N` | **Sim** | Número da fase a planejar e revisar |
| `--codex` / `--gemini` / `--claude` / `--opencode` | Não | Seleção de revisor único |
| `--all` | Não | Executa todos os revisores configurados em paralelo |
| `--max-cycles N` | Não | Substitui o limite de ciclos (padrão 3) |

**Comportamento de saída:** O loop termina quando a contagem HIGH chega a zero. A detecção de estagnação avisa quando a contagem HIGH não diminui entre ciclos. O portão de escalação solicita ao usuário que prossiga ou revise manualmente quando `--max-cycles` é atingido com preocupações HIGH ainda em aberto.

```bash
/gsd-plan-review-convergence 3                    # Revisores padrão, 3 ciclos
/gsd-plan-review-convergence 3 --codex            # Revisão somente com Codex
/gsd-plan-review-convergence 3 --all --max-cycles 5
```

---

### `/gsd-ultraplan-phase`

**[BETA]** Delega o planejamento da fase para o ultraplan em nuvem do Claude Code; revise no navegador e importe de volta. O rascunho do plano é feito remotamente, liberando o terminal; revise comentários inline no navegador e importe o plano finalizado de volta para `.planning/` via `/gsd-import`.

| Flag | Obrigatório | Descrição |
|------|-------------|-----------|
| `N` | **Sim** | Número da fase a planejar remotamente |

**Isolamento:** Intencionalmente separado de `/gsd-plan-phase` para que mudanças upstream no ultraplan não afetem o pipeline de planejamento principal.

```bash
/gsd-ultraplan-phase 4                  # Delega planejamento para a fase 4
```

---

### `/gsd-execute-phase`

Executa todos os planos de uma fase com paralelização baseada em waves, ou executa uma wave específica.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `N` | **Sim** | Número da fase a executar |
| `--wave N` | Não | Executa somente a Wave `N` da fase |
| `--cross-ai` | Não | Delega a execução para uma CLI de IA externa (usa `workflow.cross_ai_command`) |
| `--no-cross-ai` | Não | Força execução local mesmo se cross-AI estiver habilitado na configuração |

**Pré-requisitos:** A fase tem arquivos PLAN.md
**Produz:** `{phase}-{N}-SUMMARY.md` por plano, commits no git e `{phase}-VERIFICATION.md` quando a fase é completamente concluída

**Falhas de instalação de pacotes (v1.42.1):** Se a etapa de instalação de um plano falhar, o executor exibe um `checkpoint:human-verify` e para. Não instala automaticamente uma alternativa com nome similar. Isso é intencional — substituir nomes de pacotes silenciosamente é como o slopsquatting se propaga. Responda ao checkpoint após verificar o pacote na página do seu registro.

```bash
/gsd-execute-phase 1                # Executa a fase 1
/gsd-execute-phase 1 --wave 2       # Executa somente a Wave 2
/gsd-execute-phase 2 --cross-ai     # Delega a fase 2 para CLI de IA externa
```

---

### `/gsd-verify-work`

Testes de aceitação do usuário com autodiagnóstico.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `N` | Não | Número da fase (padrão: última fase executada) |

**Pré-requisitos:** A fase foi executada
**Produz:** `{phase}-UAT.md`, planos de correção caso problemas sejam encontrados

Para UAT com suporte a navegador, use um servidor MCP de navegador configurado. O companheiro Open GSD atual é `gsd-browser` (`gsd-browser mcp`), que fornece navegação determinística, refs versionadas, asserções, capturas de tela, diffs visuais, gravações e controle humano. Servidores Playwright MCP legados continuam utilizáveis quando já configurados.

```bash
/gsd-verify-work 1                  # UAT para a fase 1
```

---

---

### `/gsd-ship`

Cria PR a partir do trabalho concluído em uma fase com body gerado automaticamente.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `N` | Não | Número da fase ou versão do milestone (por exemplo, `4` ou `v1.0`) |
| `--draft` | Não | Cria como PR rascunho |

**Pré-requisitos:** Fase verificada (`/gsd-verify-work` concluído), CLI `gh` instalada e autenticada
**Produz:** PR no GitHub com body rico gerado a partir dos artefatos de planejamento, STATE.md atualizado

```bash
/gsd-ship 4                         # Publica a fase 4
/gsd-ship 4 --draft                 # Publica como PR rascunho
```

**O body do PR inclui:**
- Objetivo da fase a partir do ROADMAP.md
- Resumo de mudanças dos arquivos SUMMARY.md
- Requisitos contemplados (REQ-IDs)
- Status de verificação
- Decisões principais
- Seções opcionais configuradas no estilo PRD a partir de `ship.pr_body_sections`

Consulte [Seções Personalizadas do Body do PR](../ship-pr-body-sections.md) para integração, exemplos e regras de validação.

---

### `/gsd-ui-review`

Auditoria visual retroativa de 6 pilares do frontend implementado.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `N` | Não | Número da fase (padrão: última fase executada) |

**Pré-requisitos:** O projeto tem código frontend (funciona de forma autônoma, sem necessidade de projeto GSD)
**Produz:** `{phase}-UI-REVIEW.md`, capturas de tela em `.planning/ui-reviews/`

Para evidência visual mais rica, combine com `gsd-browser` ou outro servidor MCP de navegador, para que a auditoria possa capturar capturas de tela, estado, contexto de console/rede e etapas de interação reproduzíveis.

```bash
/gsd-ui-review                      # Audita a fase atual
/gsd-ui-review 3                    # Audita a fase 3
```

---

### `/gsd-audit-uat`

Auditoria entre fases de todos os itens pendentes de UAT e verificação.

**Pré-requisitos:** Pelo menos uma fase foi executada com UAT ou verificação
**Produz:** Relatório de auditoria categorizado com plano de testes humanos

```bash
/gsd-audit-uat
```

---

### `/gsd-audit-milestone`

Verifica se o milestone atingiu sua definição de pronto.

**Pré-requisitos:** Todas as fases executadas
**Produz:** Relatório de auditoria com análise de lacunas

```bash
/gsd-audit-milestone
```

---

### `/gsd-complete-milestone`

Arquiva o milestone e cria tag de release.

**Pré-requisitos:** Auditoria do milestone concluída (recomendado)
**Produz:** Entrada em `MILESTONES.md`, tag no git

```bash
/gsd-complete-milestone
```

---

### `/gsd-milestone-summary`

Gera resumo abrangente do projeto a partir dos artefatos do milestone para onboarding e revisão da equipe.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `version` | Não | Versão do milestone (padrão: milestone atual/mais recente) |

**Pré-requisitos:** Pelo menos um milestone concluído ou em andamento
**Produz:** `.planning/reports/MILESTONE_SUMMARY-v{version}.md`

**O resumo inclui:**
- Visão geral, decisões arquiteturais, detalhamento fase a fase
- Decisões principais e trade-offs
- Cobertura de requisitos
- Dívida técnica e itens adiados
- Guia de introdução para novos membros da equipe
- Q&A interativo oferecido após a geração

```bash
/gsd-milestone-summary                # Resume o milestone atual
/gsd-milestone-summary v1.0           # Resume um milestone específico
```

---

### `/gsd-new-milestone`

Inicia o próximo ciclo de versão.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `name` | Não | Nome do milestone |
| `--reset-phase-numbers` | Não | Reinicia o novo milestone na Fase 1 e arquiva os diretórios de fases anteriores antes do roadmapping |

**Pré-requisitos:** Milestone anterior concluído
**Produz:** `PROJECT.md` atualizado, novo `REQUIREMENTS.md`, novo `ROADMAP.md`

```bash
/gsd-new-milestone                  # Interativo
/gsd-new-milestone "v2.0 Mobile"    # Milestone nomeado
/gsd-new-milestone --reset-phase-numbers "v2.0 Mobile"  # Reinicia numeração de milestone na fase 1
```

---

## Comandos de Gerenciamento de Fases

### `/gsd-phase`

CRUD para fases no ROADMAP.md — adiciona, insere, remove ou edita fases com um único comando consolidado.

| Flag | Descrição |
|------|-----------|
| (nenhuma) | Acrescenta uma nova fase inteira ao final do milestone atual |
| `--insert <N>` | Insere trabalho urgente como uma fase decimal (por exemplo, 3.1) após a fase N |
| `--remove <N>` | Remove uma fase futura e renumera as fases subsequentes |
| `--edit <N>` | Edita qualquer campo de uma fase existente no lugar |
| `--force` | Permite editar fases em andamento ou concluídas (usado com `--edit`) |

**Pré-requisitos:** `.planning/ROADMAP.md` existe
**Produz:** ROADMAP.md atualizado

```bash
/gsd-phase "Add authentication system"          # Acrescenta nova fase com descrição
/gsd-phase --insert 3 "Fix auth race condition" # Insere entre a fase 3 e 4 → cria 3.1
/gsd-phase --remove 7               # Remove a fase 7, renumera 8→7, 9→8, etc.
/gsd-phase --edit 5                 # Edita qualquer campo da fase 5
/gsd-phase --edit 5 --force         # Edita a fase 5 mesmo se em andamento ou concluída
```

---

### `/gsd-mvp-phase`

Planejamento MVP guiado para uma fase — solicita uma história de usuário, executa verificação de divisão SPIDR, escreve `**Mode:** mvp` no ROADMAP.md e então delega para `/gsd-plan-phase` (que detecta o modo MVP automaticamente pelo campo do roadmap).

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `N` | **Sim** | Número da fase a converter para o modo MVP (inteiro ou decimal como `2.1`) |

| Flag | Descrição |
|------|-----------|
| `--force` | Permite converter uma fase `in_progress` ou `completed` |

**Pré-requisitos:** A fase já deve existir no ROADMAP.md (criada via `/gsd-new-project`, `/gsd-phase` ou `/gsd-phase --insert`). O comando não cria novas fases — ele converte uma fase existente.

**Comportamento:** Coleta uma história de usuário estruturada, valida o formato, executa uma verificação de divisão SPIDR, escreve `**Goal:**` e `**Mode:** mvp` na seção da fase no ROADMAP.md e então delega para `/gsd-plan-phase <N>`. Consulte [Como planejar uma fase MVP](USER-GUIDE.md#mvp-phase-planning) para um tutorial.

**Walking Skeleton:** Ativado automaticamente quando `--mvp` (ou `mode: mvp`) é usado na Fase 1 de um novo projeto sem resumos de fases anteriores. O planejador produz `SKELETON.md` junto com `PLAN.md`.

**Produz:** ROADMAP.md atualizado, e então todos os artefatos de `/gsd-plan-phase`; `SKELETON.md` quando o modo Walking Skeleton é ativado.

```bash
/gsd-mvp-phase 1                    # Planejamento MVP para a fase 1
/gsd-mvp-phase 2.1                  # Planejamento MVP para uma fase decimal
/gsd-mvp-phase 3 --force            # Converte a fase 3 mesmo se em andamento
```

---

### `/gsd-validate-phase`

Audita e preenche retroativamente lacunas de validação Nyquist.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `N` | Não | Número da fase |

```bash
/gsd-validate-phase 2               # Audita a cobertura de testes para a fase 2
```

---

## Comandos de Navegação

### `/gsd-progress`

Exibe status, próximos passos e avança automaticamente para a próxima etapa lógica do fluxo de trabalho. Lê o estado do projeto e determina a ação adequada.

| Flag | Descrição |
|------|-----------|
| `--next` | Avança automaticamente para a próxima etapa lógica do fluxo de trabalho sem seleção manual de rota |
| `--do "task description"` | Analisa intenção em texto livre e despacha para o comando GSD mais adequado |
| `--forensic` | Acrescenta uma auditoria de integridade de 6 verificações após o relatório padrão (consistência de STATE, handoffs órfãos, desvio de escopo adiado, trabalho pendente com flag de memória, todos bloqueantes, código sem commit) |

**Comportamento de roteamento automático (`--next`):**
- Sem projeto → sugere `/gsd-new-project`
- Fase precisa de discussão → executa `/gsd-discuss-phase`
- Fase precisa de planejamento → executa `/gsd-plan-phase`
- Fase precisa de execução → executa `/gsd-execute-phase`
- Fase precisa de verificação → executa `/gsd-verify-work`
- Todas as fases concluídas → sugere `/gsd-complete-milestone`

```bash
/gsd-progress                       # "Onde estou? O que vem a seguir?" com roteamento automático
/gsd-progress --next                # Avança automaticamente para a próxima etapa
/gsd-progress --do "fix the auth bug"  # Despacha intenção em texto livre para o melhor comando GSD
/gsd-progress --forensic            # Relatório padrão + auditoria de integridade
```

### `/gsd-resume-work`

Restaura o contexto completo da última sessão.

```bash
/gsd-resume-work                    # Após redefinição de contexto ou nova sessão
```

### `/gsd-pause-work`

Salva handoff de contexto ao parar no meio de uma fase.

| Flag | Descrição |
|------|-----------|
| `--report` | Gera um resumo pós-sessão em `.planning/reports/` com commits, mudanças de arquivos e progresso da fase |

```bash
/gsd-pause-work                     # Cria continue-here.md
/gsd-pause-work --report            # Cria continue-here.md + relatório de sessão
```

### `/gsd-manager`

Central de comando interativa para gerenciar múltiplas fases a partir de um único terminal.

**Pré-requisitos:** `.planning/ROADMAP.md` existe
**Comportamento:**
- Painel com todas as fases e indicadores visuais de status
- Recomenda as melhores ações seguintes com base em dependências e progresso
- Despacha trabalho: discuss executa inline, plan/execute executam como agentes em segundo plano
- Projetado para usuários avançados que paralelizam trabalho entre fases a partir de um único terminal
- Suporta flags de passagem por etapa via configuração `manager.flags` (consulte [Configuração](CONFIGURATION.md#manager-passthrough-flags))

```bash
/gsd-manager                        # Abre o painel da central de comando
/gsd-manager --analyze-deps         # Analisa as fases do ROADMAP em busca de relações de dependência antes da execução paralela
```

**Heartbeats de Checkpoint (#2410):**

Execuções de `execute-phase` em segundo plano emitem marcadores `[checkpoint]` a cada wave e limite de plano para que o stream SSE da API do Claude nunca fique ocioso por tempo suficiente para acionar `Stream idle timeout - partial response received` em fases com múltiplos planos. O formato é:

```
[checkpoint] phase {N} wave {W}/{M} starting, {count} plan(s), {P}/{Q} plans done
[checkpoint] phase {N} wave {W}/{M} plan {plan_id} starting ({P}/{Q} plans done)
[checkpoint] phase {N} wave {W}/{M} plan {plan_id} complete ({P}/{Q} plans done)
[checkpoint] phase {N} wave {W}/{M} complete, {P}/{Q} plans done ({ok}/{count} ok)
```

Se uma fase em segundo plano falhar parcialmente, faça grep da transcrição por `[checkpoint]`
para ver o último limite confirmado. O manipulador de conclusão em segundo plano do manager
usa esses marcadores para reportar progresso parcial quando um agente apresenta erro.

**Flags de Passagem do Manager:**

Configure flags por etapa em `.planning/config.json` sob `manager.flags`. Essas flags são adicionadas a cada comando despachado:

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

Exibe os comandos GSD no nível solicitado. O padrão cabe em uma tela; `--full` é a referência completa; `<topic>` pula diretamente para uma seção.

```bash
/gsd-help                           # Tour de uma página (padrão)
/gsd-help --brief                   # Recapitulação resumida em ~10 linhas dos principais comandos
/gsd-help --full                    # Referência completa (todos os comandos, todas as flags)
/gsd-help <topic>                   # Somente uma seção (por exemplo /gsd-help debug)
/gsd-help --brief <topic>           # Consulta resumida com escopo — assinatura + resumo em uma linha
```

Consulte `gsd-core/workflows/help/modes/topic.md` para a tabela completa de aliases. Tópicos desconhecidos exibem a lista reconhecida.

---

## Comandos Utilitários

### `/gsd-explore`

Sessão de ideação socrática — guia uma ideia por meio de perguntas investigativas, opcionalmente cria pesquisa, e então roteia a saída para o artefato GSD adequado (notas, todos, seeds, perguntas de pesquisa, requisitos ou uma nova fase).

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `topic` | Não | Tópico a explorar (por exemplo, `/gsd-explore authentication strategy`) |

```bash
/gsd-explore                        # Sessão de ideação aberta
/gsd-explore authentication strategy  # Explora um tópico específico
```

---

### `/gsd-undo`

Reversão segura no git — reverte commits de fase ou plano do GSD usando o manifesto da fase com verificações de dependências e um portão de confirmação.

| Flag | Obrigatório | Descrição |
|------|-------------|-----------|
| `--last N` | (um dos três obrigatórios) | Exibe commits GSD recentes para seleção interativa |
| `--phase NN` | (um dos três obrigatórios) | Reverte todos os commits de uma fase |
| `--plan NN-MM` | (um dos três obrigatórios) | Reverte todos os commits de um plano específico |

**Segurança:** Verifica fases/planos dependentes antes de reverter; sempre exibe um portão de confirmação.

```bash
/gsd-undo --last 5                  # Escolhe entre os 5 commits GSD mais recentes
/gsd-undo --phase 03                # Reverte todos os commits da fase 3
/gsd-undo --plan 03-02              # Reverte commits do plano 02 da fase 3
```

---

### `/gsd-import`

Ingere um arquivo de plano externo no sistema de planejamento do GSD com detecção de conflitos contra as decisões do `PROJECT.md` antes de escrever qualquer coisa.

| Flag | Obrigatório | Descrição |
|------|-------------|----------|
| `--from <filepath>` | Sim (ou `--from-gsd2`) | Caminho para o arquivo de plano externo a importar |
| `--from-gsd2` | Sim (ou `--from`) | Migração reversa de um projeto GSD-2 (`.gsd/`) de volta para o formato GSD v1 (`.planning/`) |
| `--path <dir>` | Não | Com `--from-gsd2`: caminho para o diretório do projeto GSD-2 (padrão: diretório atual) |

**Processo:** Detecta conflitos → solicita resolução → escreve como GSD PLAN.md → valida via `gsd-plan-checker`

```bash
/gsd-import --from /tmp/team-plan.md    # Importa e valida um plano externo
/gsd-import --from-gsd2                # Migra do GSD-2 de volta para v1 (diretório atual)
/gsd-import --from-gsd2 --path ~/old-project  # Migra a partir de um caminho diferente
```

---

### `/gsd-ingest-docs`

Inicializa ou mescla uma configuração `.planning/` a partir de ADRs, PRDs, SPECs e documentos existentes em um repositório. Executa classificação paralela (`gsd-doc-classifier`) mais síntese com regras de precedência e detecção de ciclos (`gsd-doc-synthesizer`). Produz um relatório de conflitos em três categorias (`INGEST-CONFLICTS.md`: auto-resolvidos, variantes-concorrentes, bloqueadores-não-resolvidos) e bloqueia completamente em contradições ADR LOCKED-vs-LOCKED.

| Argumento / Flag | Obrigatório | Descrição |
|-----------------|-------------|-----------|
| `path` | Não | Diretório alvo para varredura (padrão: raiz do repositório) |
| `--mode new\|merge` | Não | Substitui a detecção automática (padrões: `new` se `.planning/` ausente, `merge` se presente) |
| `--manifest <file>` | Não | Arquivo YAML listando `{path, type, precedence?}` por documento; substitui a classificação heurística |
| `--resolve auto` | Não | Modo de resolução de conflitos (v1: somente `auto`; `interactive` está reservado) |

**Limites:** v1 suporta no máximo 50 documentos por invocação. Extrai o contrato compartilhado de detecção de conflitos em `references/doc-conflict-engine.md`, que `/gsd-import` também consome.

```bash
/gsd-ingest-docs                            # Varre a raiz do repositório, detecção automática de modo
/gsd-ingest-docs docs/                      # Ingere somente sob docs/
/gsd-ingest-docs --manifest ingest.yaml     # Manifesto explícito de precedência
```

---

### `/gsd-quick`

Executa tarefa ad-hoc com garantias do GSD.

| Flag | Descrição |
|------|-----------|
| `--full` | Habilita o pipeline completo de qualidade — discussão + pesquisa + verificação de plano + verificação |
| `--validate` | Somente verificação de plano (máx. 2 iterações) + verificação pós-execução; sem discussão ou pesquisa |
| `--discuss` | Discussão pré-planejamento leve |
| `--research` | Cria agente pesquisador antes do planejamento |

Flags granulares são combináveis: `--discuss --research --validate` é equivalente a `--full`.

| Subcomando | Descrição |
|------------|-----------|
| `list` | Lista todas as tarefas quick com status |
| `status <slug>` | Exibe status de uma tarefa quick específica |
| `resume <slug>` | Retoma uma tarefa quick específica pelo slug |

```bash
/gsd-quick                          # Tarefa quick básica
/gsd-quick --discuss --research     # Discussão + pesquisa + planejamento
/gsd-quick --validate               # Somente verificação de plano + verificação
/gsd-quick --full                   # Pipeline completo de qualidade
/gsd-quick list                     # Lista todas as tarefas quick
/gsd-quick status my-task-slug      # Exibe status de uma tarefa quick
/gsd-quick resume my-task-slug      # Retoma uma tarefa quick
```

### `/gsd-autonomous`

Executa todas as fases restantes de forma autônoma.

| Flag | Descrição |
|------|-----------|
| `--from N` | Inicia a partir de um número de fase específico |
| `--to N` | Para após concluir um número de fase específico |
| `--interactive` | Contexto enxuto com entrada do usuário |

```bash
/gsd-autonomous                     # Executa todas as fases restantes
/gsd-autonomous --from 3            # Inicia a partir da fase 3
/gsd-autonomous --to 5              # Executa até a fase 5, inclusive
/gsd-autonomous --from 3 --to 5     # Executa as fases 3 a 5
```

### `/gsd-debug`

Depuração sistemática com estado persistente.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `description` | Não | Descrição do bug |

| Flag | Descrição |
|------|-----------|
| `--diagnose` | Modo somente diagnóstico — investiga sem tentar correções |

**Subcomandos:**
- `/gsd-debug list` — Lista todas as sessões de debug ativas com status, hipótese e próxima ação
- `/gsd-debug status <slug>` — Imprime resumo completo de uma sessão (contagem de Evidências, Eliminadas, Resolução, checkpoint TDD) sem criar um agente
- `/gsd-debug continue <slug>` — Retoma uma sessão específica pelo slug (exibe Foco Atual e então cria agente de continuação)
- `/gsd-debug [--diagnose] <description>` — Inicia nova sessão de debug (comportamento existente; `--diagnose` para na causa raiz sem aplicar correção)

**Modo TDD:** Quando `tdd_mode: true` em `.planning/config.json`, sessões de debug exigem que um teste falho seja escrito e verificado antes que qualquer correção seja aplicada (vermelho → verde → concluído).

```bash
/gsd-debug "Login button not responding on mobile Safari"
/gsd-debug --diagnose "Intermittent 500 errors on /api/users"
/gsd-debug list
/gsd-debug status auth-token-null
/gsd-debug continue form-submit-500
```

### `/gsd-add-tests`

Gera testes para uma fase concluída.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `N` | Não | Número da fase |

```bash
/gsd-add-tests 2                    # Gera testes para a fase 2
```

### `/gsd-stats`

Exibe estatísticas do projeto.

```bash
/gsd-stats                          # Painel de métricas do projeto
```

### `/gsd-profile-user`

Gera um perfil comportamental do desenvolvedor a partir da análise de sessões do Claude Code em 8 dimensões (estilo de comunicação, padrões de decisão, abordagem de depuração, preferências de UX, escolhas de fornecedores, gatilhos de frustração, estilo de aprendizado, profundidade de explicação). Produz artefatos que personalizam as respostas do Claude.

| Flag | Descrição |
|------|-----------|
| `--questionnaire` | Usa questionário interativo em vez de análise de sessões |
| `--refresh` | Reanalisas sessões e regenera o perfil |

**Artefatos gerados:**
- `USER-PROFILE.md` — Perfil comportamental completo
- Seção de perfil `CLAUDE.md` — Descoberta automaticamente pelo Claude Code

```bash
/gsd-profile-user                   # Analisa sessões e constrói perfil
/gsd-profile-user --questionnaire   # Alternativa com questionário interativo
/gsd-profile-user --refresh         # Regenera a partir de nova análise
```

### `/gsd-health`

Valida a integridade do diretório `.planning/`. Com `--context`, verifica a guarda de utilização da janela de contexto em relação aos limiares de 60% / 70% (adicionado na
v1.40.0, [#2792](https://github.com/open-gsd/gsd-core/issues/2792)).

| Flag | Descrição |
|------|-----------|
| `--repair` | Corrige automaticamente problemas recuperáveis |
| `--context` | Verifica utilização da janela de contexto; avisa em 60%, crítico em 70% |

```bash
/gsd-health                         # Verifica integridade
/gsd-health --repair                # Verifica e corrige
/gsd-health --context               # Triagem de utilização de contexto
```

### `/gsd-cleanup`

Arquiva diretórios de fases acumulados de milestones concluídos e poda branches locais cujo upstream foi excluído.

**Comportamento:** Apresenta um resumo em modo dry-run dos diretórios de fases a arquivar (movidos de `.planning/phases/` para `.planning/milestones/v{X.Y}-phases/`) e branches locais cujo upstream não existe mais (podados via `git fetch --prune`). Requer confirmação antes de escrever quaisquer mudanças. O branch atualmente com checkout nunca é podado.

```bash
/gsd-cleanup
```

---

## Comandos de Spiking e Sketching

### `/gsd-spike`

Executa 2–5 experimentos focados de viabilidade antes de se comprometer com uma abordagem de implementação. Cada experimento usa o enquadramento Given/When/Then, produz código executável e retorna um veredicto VALIDATED / INVALIDATED / PARTIAL.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `idea` | Não | A questão técnica ou abordagem a investigar |
| `--quick` | Não | Ignora a conversa de intake; usa o texto `idea` diretamente |
| `--wrap-up` | Não | Empacota as descobertas concluídas do spike em uma skill reutilizável local do projeto |

**Produz:** `.planning/spikes/NNN-experiment-name/` com código, resultados e README; `.planning/spikes/MANIFEST.md`
**`--wrap-up` produz:** arquivo de skill `.claude/skills/spike-findings-[project]/`

```bash
/gsd-spike                              # Intake interativo
/gsd-spike "can we stream LLM tokens through SSE"
/gsd-spike --quick websocket-vs-polling
/gsd-spike --wrap-up                    # Empacota descobertas em uma skill reutilizável
```

---

### `/gsd-sketch`

Explora direções de design por meio de mockups HTML descartáveis antes de se comprometer com a implementação. Produz 2–3 variantes por questão de design para comparação direta no navegador.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `idea` | Não | A questão ou direção de design de UI a explorar |
| `--quick` | Não | Ignora o intake de mood; usa o texto `idea` diretamente |
| `--text` | Não | Alternativa em modo texto — substitui prompts interativos por listas numeradas (para runtimes que não são o Claude) |
| `--wrap-up` | Não | Empacota as decisões vencedoras do sketch em uma skill reutilizável local do projeto |

**Produz:** `.planning/sketches/NNN-descriptive-name/index.html` (2–3 variantes interativas), `README.md`, `themes/default.css` compartilhado; `.planning/sketches/MANIFEST.md`
**`--wrap-up` produz:** arquivo de skill `.claude/skills/sketch-findings-[project]/`

```bash
/gsd-sketch                             # Intake interativo de mood
/gsd-sketch "dashboard layout"
/gsd-sketch --quick "sidebar navigation"
/gsd-sketch --text "onboarding flow"    # Runtime que não é o Claude
/gsd-sketch --wrap-up                   # Empacota o sketch vencedor em uma skill
```

---

## Comandos de Diagnósticos

### `/gsd-forensics`

Investigação pós-mortem para fluxos de trabalho GSD com falha — diagnostica o que deu errado.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `description` | Não | Descrição do problema (solicitado se omitido) |

**Pré-requisitos:** Diretório `.planning/` existe
**Produz:** `.planning/forensics/report-{timestamp}.md`

**A investigação cobre:**
- Análise do histórico do git (commits recentes, padrões de travamento, lacunas de tempo)
- Integridade dos artefatos (arquivos esperados para fases concluídas)
- Anomalias no STATE.md e histórico de sessões
- Trabalho sem commit, conflitos, mudanças abandonadas
- Pelo menos 4 tipos de anomalias verificados (loop travado, artefatos ausentes, trabalho abandonado, crash/interrupção)
- Criação de issue no GitHub oferecida se descobertas acionáveis existirem

```bash
/gsd-forensics                              # Interativo — solicitação de problema
/gsd-forensics "Phase 3 execution stalled"  # Com descrição do problema
```

---

### `/gsd-extract-learnings`

Extrai padrões reutilizáveis, antipadrões e decisões arquiteturais do trabalho concluído de uma fase.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `N` | **Sim** | Número da fase da qual extrair aprendizados |

| Flag | Descrição |
|------|-----------|
| `--all` | Extrai aprendizados de todas as fases concluídas |
| `--format` | Formato de saída: `markdown` (padrão), `json` |

**Pré-requisitos:** A fase foi executada (arquivos SUMMARY.md existem)
**Produz:** `.planning/learnings/{phase}-LEARNINGS.md`

**Extrai:**
- Decisões arquiteturais e sua justificativa
- Padrões que funcionaram bem (reutilizáveis em fases futuras)
- Antipadrões encontrados e como foram resolvidos
- Insights específicos de tecnologia
- Observações de performance e testes

```bash
/gsd-extract-learnings 3                    # Extrai aprendizados da fase 3
/gsd-extract-learnings --all                # Extrai de todas as fases concluídas
```

---

## Gerenciamento de Workstreams

### `/gsd-workstreams`

Gerencia workstreams paralelos para trabalho simultâneo em diferentes áreas do milestone.

**Subcomandos:**

| Subcomando | Descrição |
|------------|-----------|
| `list` | Lista todos os workstreams com status (padrão se nenhum subcomando) |
| `create <name>` | Cria um novo workstream |
| `status <name>` | Status detalhado de um workstream |
| `switch <name>` | Define o workstream ativo |
| `progress` | Resumo de progresso entre todos os workstreams |
| `complete <name>` | Arquiva um workstream concluído |
| `resume <name>` | Retoma trabalho em um workstream |

**Pré-requisitos:** Projeto GSD ativo
**Produz:** Diretórios de workstream sob `.planning/`, rastreamento de estado por workstream

```bash
/gsd-workstreams                    # Lista todos os workstreams
/gsd-workstreams create backend-api # Cria novo workstream
/gsd-workstreams switch backend-api # Define workstream ativo
/gsd-workstreams status backend-api # Status detalhado
/gsd-workstreams progress           # Visão geral de progresso entre workstreams
/gsd-workstreams complete backend-api  # Arquiva workstream concluído
/gsd-workstreams resume backend-api    # Retoma trabalho no workstream
```

---

## Comandos de Configuração

### `/gsd-settings`

Configuração interativa de toggles de fluxo de trabalho e perfil de modelo. As perguntas são agrupadas em seis seções visuais:

- **Planning** — Research, Plan Checker, Pattern Mapper, Nyquist, UI Phase, UI Gate, AI Phase
- **Execution** — Verifier, TDD Mode, Code Review, Code Review Depth _(condicional — somente quando Code Review está ativado)_, UI Review
- **Docs & Output** — Commit Docs, Skip Discuss, Worktrees
- **Features** — Intel, Graphify
- **Model & Pipeline** — Model Profile, Auto-Advance, Branching
- **Misc** — Context Warnings, Research Qs

Todas as respostas são mescladas via `gsd-tools query config-set` no caminho de configuração do projeto resolvido (`.planning/config.json` para uma instalação padrão, ou `.planning/workstreams/<active>/config.json` quando um workstream está ativo), preservando chaves não relacionadas. Após a confirmação, o usuário pode salvar o objeto de configurações completo em `~/.gsd/defaults.json` para que execuções futuras de `/gsd-new-project` comecem da mesma linha de base.

```bash
/gsd-settings                       # Configuração interativa
```

### `/gsd-config`

Configura as definições do GSD interativamente — toggles de fluxo de trabalho, controles avançados, integrações e perfil de modelo — com um único comando consolidado.

| Flag | Descrição |
|------|-----------|
| (nenhuma) | Toggles de caso comum: model, research, plan_check, verifier, branching |
| `--advanced` | Controles para usuários avançados: ajuste de planejamento, timeouts, templates de branch, execução cross-AI, runtime/saída |
| `--integrations` | Chaves de API de terceiros, roteamento de CLI de revisão de código, injeção de skill de agente |
| `--profile <name>` | Troca rápida de perfil: `quality`, `balanced`, `budget` ou `inherit` |

**Seções de `--advanced`:**

| Seção | Chaves |
|-------|--------|
| Planning Tuning | `workflow.plan_bounce`, `workflow.plan_bounce_passes`, `workflow.plan_bounce_script`, `workflow.subagent_timeout`, `workflow.inline_plan_threshold` |
| Execution Tuning | `workflow.node_repair`, `workflow.node_repair_budget`, `workflow.auto_prune_state` |
| Discussion Tuning | `workflow.max_discuss_passes` |
| Cross-AI Execution | `workflow.cross_ai_execution`, `workflow.cross_ai_command`, `workflow.cross_ai_timeout` |
| Git Customization | `git.base_branch`, `git.phase_branch_template`, `git.milestone_branch_template` |
| Runtime / Output | `response_language`, `context_window`, `search_gitignored`, `graphify.build_timeout` |

Todas as respostas são mescladas via `gsd-tools query config-set`, preservando chaves não relacionadas. Chaves de API são mascaradas (`****<últimos-4>`) em todas as saídas.

```bash
/gsd-config                         # Configuração interativa de caso comum
/gsd-config --advanced              # Controles para usuários avançados (prompt de seis seções)
/gsd-config --integrations          # Chaves de API, roteamento de CLI de revisão, skills de agente
/gsd-config --profile budget        # Troca para o perfil budget
/gsd-config --profile quality       # Troca para o perfil quality
```

Consulte [CONFIGURATION.md](CONFIGURATION.md) para o esquema completo e valores padrão.

### `/gsd-surface`

Alterna quais skills são expostas — aplica um perfil, lista ou desativa um cluster sem reinstalação.

| Subcomando | Descrição |
|------------|-----------|
| `list` | Exibe clusters e skills habilitados e desabilitados |
| `status` | Alias para `list` mais resumo de custo de tokens |
| `profile <name>` | Escreve `baseProfile` e reencena skills |
| `disable <cluster>` | Adiciona cluster à lista de desabilitados e reencena |
| `enable <cluster>` | Remove cluster da lista de desabilitados e reencena |
| `reset` | Exclui o delta de superfície; retorna ao perfil do momento da instalação |

```bash
/gsd-surface list                   # Exibe a superfície atual
/gsd-surface profile standard       # Troca para o perfil standard
/gsd-surface disable utility        # Desativa o cluster utility
/gsd-surface reset                  # Restaura o perfil do momento da instalação
```

---

## Comandos para Brownfield

### `/gsd-map-codebase`

Analisa a base de código existente com agentes mapeadores paralelos. Use `--fast` para uma varredura rápida de agente único, ou `--query` para pesquisar intel existente.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `area` | Não | Limita o mapeamento a uma área específica |
| `--fast` | Não | Avaliação rápida de foco único — cria um agente mapeador em vez de quatro paralelos (alternativa leve) |
| `--query <term>` | Não | Pesquisa arquivos de intel consultáveis da base de código em `.planning/intel/` (requer `intel.enabled: true`) |

| Flag | Descrição |
|------|-----------|
| `--focus tech\|arch\|quality\|concerns\|tech+arch` | Área de foco para o modo `--fast` (padrão: `tech+arch`) |

**Produz:** Documentos de análise `.planning/codebase/` (modo completo); documento(s) direcionado(s) em `.planning/codebase/` (`--fast`); resultados de consulta intel (`--query`)

```bash
/gsd-map-codebase                   # Análise completa da base de código (4 agentes paralelos)
/gsd-map-codebase auth              # Foca na área de autenticação
/gsd-map-codebase --fast            # Visão geral rápida de tech + arch (1 agente)
/gsd-map-codebase --fast --focus quality  # Somente qualidade e saúde do código
/gsd-map-codebase --query authentication  # Pesquisa intel por um termo
```

### `/gsd-graphify`

Constrói, consulta e inspeciona o grafo de conhecimento do projeto armazenado em `.planning/graphs/`. Ativação opt-in via `graphify.enabled: true` em `config.json` (consulte [Referência de Configuração](CONFIGURATION.md#graphify-settings)); quando desabilitado, o comando imprime uma dica de ativação e para.

| Subcomando | Descrição |
|------------|-----------|
| `build` | Constrói ou reconstrói o grafo de conhecimento (executa `graphify update .` inline e atualiza `.planning/graphs/`) |
| `query <term>` | Pesquisa o grafo por um termo |
| `status` | Exibe frescor e estatísticas do grafo |
| `diff` | Exibe mudanças desde a última construção |

**Produz:** Artefatos do grafo `.planning/graphs/` (nós, arestas, snapshots)

```bash
/gsd-graphify build                 # Constrói ou reconstrói o grafo de conhecimento
/gsd-graphify query authentication  # Pesquisa o grafo por um termo
/gsd-graphify status                # Exibe frescor e estatísticas
/gsd-graphify diff                  # Exibe mudanças desde a última construção
```

**Acesso programático:** `node gsd-tools.cjs graphify <build|query|status|diff|snapshot>` — consulte a [Referência de Ferramentas CLI](CLI-TOOLS.md).

### `gsd-tools intel api-surface`

Renderiza o índice `.planning/intel/api-map.json` (construído por `/gsd-map-codebase`) em um `API-SURFACE.md` legível por humanos em `.planning/intel/`. Requer `intel.enabled: true` em `config.json`; quando Intel está desabilitado, o comando imprime uma dica de ativação e sai. O caminho de saída é sempre `.planning/intel/API-SURFACE.md` — não há flag `--out` ou `--format`. Quando `api-map.json` está ausente ou vazio, o comando ainda escreve o arquivo com um banner explícito de "incompleto" para que os consumidores nunca confundam silêncio com "nada existe".

**Produz:** `.planning/intel/API-SURFACE.md`

```bash
node gsd-tools.cjs intel api-surface              # Renderiza api-map.json → API-SURFACE.md
```

A saída de `API-SURFACE.md` lista símbolos exportados (funções, classes, decoradores, constantes) agrupados por arquivo de origem com suas assinaturas e visibilidade detectada. Quando `plan_review.source_grounding_authority` está definido como `intel`, a guarda de desvio de plano lê `api-map.json` diretamente em vez de invocar o renderizador `api-surface`.

---

## Comandos de Integração com IA

### `/gsd-ai-integration-phase`

Gera um contrato de design AI-SPEC.md para fases que envolvem a construção de sistemas de IA. Apresenta uma matriz de decisão interativa, expõe modos de falha específicos do domínio e critérios de avaliação, e produz `AI-SPEC.md` com recomendação de framework, orientação de implementação e estratégia de avaliação.

**Produz:** `{phase}-AI-SPEC.md` no diretório da fase

**Cria:** 3 agentes especialistas paralelos: domain-researcher, framework-selector, ai-researcher e eval-planner

```bash
/gsd-ai-integration-phase              # Assistente para a fase atual
/gsd-ai-integration-phase 3           # Assistente para uma fase específica
```

---

### `/gsd-eval-review`

Audita a cobertura de avaliação de uma fase de IA executada e produz um plano de remediação EVAL-REVIEW.md. Verifica a implementação em relação ao plano de avaliação `AI-SPEC.md` produzido por `/gsd-ai-integration-phase`. Classifica cada dimensão de avaliação como COVERED/PARTIAL/MISSING.

**Pré-requisitos:** A fase foi executada e possui um `AI-SPEC.md`
**Produz:** `{phase}-EVAL-REVIEW.md` com descobertas, lacunas e orientações de remediação

```bash
/gsd-eval-review                       # Audita a fase atual
/gsd-eval-review 3                     # Audita uma fase específica
```

---

## Comandos de Atualização

### `/gsd-update`

Atualiza o GSD com prévia do changelog, e opcionalmente sincroniza skills ou reaplicar patches locais.

| Flag | Descrição |
|------|-----------|
| `--sync` | Sincroniza skills do registro GSD após a atualização |
| `--reapply` | Restaura modificações locais (patches) após a atualização |

```bash
/gsd-update                         # Verifica atualizações e instala
/gsd-update --sync                  # Atualiza e sincroniza skills
/gsd-update --reapply               # Atualiza e reaplicar patches locais
```

---

## Comandos de Qualidade de Código

### `/gsd-code-review`

Revisa arquivos de código-fonte alterados durante uma fase em busca de bugs, vulnerabilidades de segurança e problemas de qualidade de código. Use `--fix` para corrigir automaticamente os problemas encontrados após a revisão.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `N` | **Sim** | Número da fase cujas mudanças revisar (por exemplo, `2` ou `02`) |
| `--depth=quick\|standard\|deep` | Não | Nível de profundidade da revisão (substitui a configuração `workflow.code_review_depth`). `quick`: somente correspondência de padrões (~2 min). `standard`: análise por arquivo com verificações específicas de linguagem (~5–15 min, padrão). `deep`: análise entre arquivos incluindo grafos de importação e cadeias de chamadas (~15–30 min) |
| `--files file1,file2,...` | Não | Lista explícita de arquivos separados por vírgula; ignora completamente o escopo SUMMARY/git |
| `--fix` | Não | Corrige automaticamente problemas após a revisão — lê REVIEW.md, cria agente corretor, faz commit de cada correção atomicamente |
| `--fix --all` | Não | Inclui descobertas Info no escopo de correção (padrão: somente Critical + Warning) |
| `--fix --auto` | Não | Loop de correção + nova revisão, limitado a 3 iterações |

**Pré-requisitos:** A fase foi executada e tem SUMMARY.md ou histórico no git
**Produz:** `{phase}-REVIEW.md` com descobertas classificadas por gravidade; `{phase}-REVIEW-FIX.md` quando `--fix` é usado
**Cria:** agente `gsd-code-reviewer`; agente `gsd-code-fixer` (com `--fix`)

**Pré-passagem estrutural opcional:** Defina `code_quality.fallow.enabled` como `true` para executar fallow antes da revisão pelo agente. O GSD escreve `{phase}/FALLOW.json` e incorpora uma seção `Structural Findings (fallow)` em `REVIEW.md`. Configure escopo e perfil com `code_quality.fallow.scope` e `code_quality.fallow.profile`.

```bash
/gsd-code-review 3                          # Revisão padrão para a fase 3
/gsd-code-review 2 --depth=deep             # Revisão profunda entre arquivos
/gsd-code-review 4 --files src/auth.ts,src/token.ts  # Lista explícita de arquivos
/gsd-code-review 3 --fix                    # Revisa e corrige descobertas Critical + Warning
/gsd-code-review 3 --fix --all             # Revisa e corrige todas as descobertas incluindo Info
/gsd-code-review 3 --fix --auto            # Revisa, corrige e revisita até estar limpo (máx. 3 iterações)
```

---

### `/gsd-audit-fix`

Pipeline autônomo de auditoria para correção — executa uma auditoria, classifica descobertas, corrige problemas corrigíveis automaticamente com verificação de testes e faz commit de cada correção atomicamente.

| Flag | Descrição |
|------|-----------|
| `--source <audit>` | Qual auditoria executar (padrão: `audit-uat`) |
| `--severity high\|medium\|all` | Gravidade mínima a processar (padrão: `medium`) |
| `--max N` | Número máximo de descobertas a corrigir (padrão: 5) |
| `--dry-run` | Classifica descobertas sem corrigir (exibe tabela de classificação) |

**Pré-requisitos:** Pelo menos uma fase foi executada com UAT ou verificação
**Produz:** Commits de correção com verificação de testes; relatório de classificação

```bash
/gsd-audit-fix                              # Executa audit-uat, corrige problemas medium+ (máx. 5)
/gsd-audit-fix --severity high             # Corrige somente problemas de alta gravidade
/gsd-audit-fix --dry-run                   # Prévia de classificação sem correção
/gsd-audit-fix --max 10 --severity all     # Corrige até 10 problemas de qualquer gravidade
```

---

## Comandos Rápidos e Inline

### `/gsd-fast`

Executa uma tarefa trivial inline — sem subagentes, sem overhead de planejamento. Para correções de tipografia, mudanças de configuração, refatorações pequenas, commits esquecidos.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `task description` | Não | O que fazer (solicitado se omitido) |

**Não substitui `/gsd-quick`** — use `/gsd-quick` para qualquer coisa que precise de pesquisa, planejamento em múltiplas etapas ou verificação.

```bash
/gsd-fast "fix typo in README"
/gsd-fast "add .env to gitignore"
```

---

### `/gsd-review`

Revisão por pares cross-AI de planos de fase a partir de CLIs de IA externas.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `--phase N` | **Sim** | Número da fase a revisar |

| Flag | Descrição |
|------|-----------|
| `--gemini` | Inclui revisão pelo Gemini CLI |
| `--claude` | Inclui revisão pelo Claude CLI (sessão separada) |
| `--codex` | Inclui revisão pelo Codex CLI |
| `--coderabbit` | Inclui revisão pelo CodeRabbit |
| `--opencode` | Inclui revisão pelo OpenCode (via GitHub Copilot) |
| `--qwen` | Inclui revisão pelo Qwen Code (modelos Alibaba Qwen) |
| `--cursor` | Inclui revisão pelo agente Cursor |
| `--agy` / `--antigravity` | Inclui revisão pelo Antigravity CLI (gratuito com credenciais Google) |
| `--ollama` | Inclui revisão pelo servidor Ollama |
| `--lm-studio` | Inclui revisão pelo servidor LM Studio |
| `--llama-cpp` | Inclui revisão pelo servidor llama.cpp |
| `--all` | Inclui todos os revisores disponíveis (CLI + servidores de modelos locais) |

**Comportamento do revisor padrão (sem flags):**
- Se `review.default_reviewers` estiver **não definido**, `/gsd-review` executa todos os revisores detectados (comportamento padrão atual).
- Se `review.default_reviewers` estiver **definido**, `/gsd-review` executa somente esse subconjunto (por exemplo `["gemini","codex"]`).
- `--all` sempre substitui a configuração e executa o conjunto detectado completo.
- Flags explícitas (por exemplo `--cursor`) substituem tanto `--all` quanto os padrões de configuração para aquela execução.

**Produz:** `{phase}-REVIEWS.md` — consumível por `/gsd-plan-phase --reviews`

```bash
# define revisores padrão do projeto para execuções de /gsd-review sem flag
gsd config-set review.default_reviewers '["gemini","codex"]'

/gsd-review --phase 2             # executa gemini+codex da configuração
/gsd-review --phase 3 --all
/gsd-review --phase 2 --gemini
/gsd-review --phase 2 --cursor    # substituição avulsa
```

---

### `/gsd-pr-branch`

Cria um branch limpo para PR filtrando commits de `.planning/`.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `target branch` | Não | Branch base (padrão: `main`) |

**Objetivo:** Revisores veem somente mudanças de código, não artefatos de planejamento do GSD.

```bash
/gsd-pr-branch                     # Filtra em relação ao main
/gsd-pr-branch develop             # Filtra em relação ao develop
```

---

### `/gsd-secure-phase`

Verifica retroativamente as mitigações de ameaças para uma fase concluída.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `phase number` | Não | Fase a auditar (padrão: última fase concluída) |

**Pré-requisitos:** A fase deve ter sido executada. Funciona com ou sem SECURITY.md existente.
**Produz:** `{phase}-SECURITY.md` com resultados de verificação de ameaças
**Cria:** agente `gsd-security-auditor`

Três modos de operação:
1. SECURITY.md existe — audita e verifica mitigações existentes
2. Sem SECURITY.md mas PLAN.md tem modelo de ameaças — gera a partir dos artefatos
3. Fase não executada — sai com orientações

```bash
/gsd-secure-phase                   # Audita a última fase concluída
/gsd-secure-phase 5                 # Audita uma fase específica
```

---

### `/gsd-docs-update`

Gera ou atualiza a documentação do projeto verificada em relação à base de código.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| `--force` | Não | Ignora prompts de preservação, regenera todos os documentos |
| `--verify-only` | Não | Verifica a precisão dos documentos existentes, sem geração |

**Produz:** Até 9 arquivos de documentação (README, arquitetura, API, introdução, desenvolvimento, testes, configuração, implantação, contribuição)
**Cria:** agentes `gsd-doc-writer` (um por tipo de documento), e então agentes `gsd-doc-verifier` para verificação factual

Cada escritor de documentos explora a base de código diretamente — sem caminhos alucinados ou assinaturas desatualizadas. O verificador de documentos confere afirmações em relação ao sistema de arquivos real.

```bash
/gsd-docs-update                    # Gera/atualiza documentos interativamente
/gsd-docs-update --force            # Regenera todos os documentos
/gsd-docs-update --verify-only      # Somente verifica documentos existentes
```

---

## Comandos de Captura de Tarefas e Backlog

### `/gsd-capture`

Captura ideias, tarefas, notas e seeds para seu destino adequado. O modo padrão adiciona um todo estruturado; flags roteiam para fluxos de trabalho de captura especializados.

| Flag | Descrição |
|------|-----------|
| (nenhuma) | Captura como um todo estruturado para trabalho posterior |
| `--note [text]` | Nota sem fricção — adiciona, lista (`--note list`) ou promove (`--note promote N`) |
| `--backlog <description>` | Adiciona ao estacionamento de backlog usando numeração 999.x |
| `--seed [idea summary]` | Captura uma ideia prospectiva com condições de ativação |
| `--list` | Lista todos os todos pendentes e seleciona um para trabalhar |
| `--global` | Usa escopo global (para operações de nota) |

**Backlog:** A numeração 999.x mantém itens fora da sequência de fases ativas; os diretórios de fases são criados imediatamente para que `/gsd-discuss-phase` e `/gsd-plan-phase` funcionem neles.
**Seeds:** Preservam o POR QUÊ completo, QUANDO expor e rastros de contexto — consumidos por `/gsd-new-milestone`.

**Produz:** `.planning/todos/` (padrão), arquivos de notas (--note), seção de backlog do ROADMAP.md (--backlog), `.planning/seeds/SEED-NNN-slug.md` (--seed)

```bash
/gsd-capture "Consider adding dark mode support"   # Adiciona todo
/gsd-capture --note "Caching strategy idea"        # Nota rápida
/gsd-capture --note list                           # Lista todas as notas
/gsd-capture --note promote 3                      # Promove nota 3 para todo
/gsd-capture --backlog "GraphQL API layer"         # Adiciona ao backlog
/gsd-capture --seed "Add real-time collaboration when WebSocket infra is in place"
/gsd-capture --list                                # Navega e age sobre todos
```

---

### `/gsd-review-backlog`

Revisa e promove itens de backlog para o milestone ativo.

**Ações por item:** Promover (mover para a sequência ativa), Manter (deixar no backlog), Remover (excluir).

```bash
/gsd-review-backlog
```

---

### `/gsd-thread`

Gerencia threads de contexto persistentes para trabalho entre sessões.

| Argumento | Obrigatório | Descrição |
|-----------|-------------|-----------|
| (nenhum) / `list` | — | Lista todas as threads |
| `list --open` | — | Lista threads com status `open` ou `in_progress` apenas |
| `list --resolved` | — | Lista threads com status `resolved` apenas |
| `status <slug>` | — | Exibe status de uma thread específica |
| `close <slug>` | — | Marca uma thread como resolvida |
| `name` | — | Retoma thread existente pelo nome |
| `description` | — | Cria nova thread |

Threads são armazenamentos de conhecimento leves entre sessões para trabalho que abrange múltiplas sessões, mas não pertence a nenhuma fase específica. Mais leve que `/gsd-pause-work`.

```bash
/gsd-thread                         # Lista todas as threads
/gsd-thread list --open             # Lista somente threads abertas/em andamento
/gsd-thread list --resolved         # Lista somente threads resolvidas
/gsd-thread status fix-deploy-key   # Exibe status da thread
/gsd-thread close fix-deploy-key    # Marca thread como resolvida
/gsd-thread fix-deploy-key-auth     # Retoma thread
/gsd-thread "Investigate TCP timeout in pasta service"  # Cria nova
```

---

## Comandos de Gerenciamento do Roadmap

### `roadmap validate`

Valida o ROADMAP.md quanto à integridade estrutural, incluindo consistência de prefixo de milestone.

**Pré-requisitos:** `.planning/ROADMAP.md` existe
**Produz:** Relatório de validação; sai com código não-zero em qualquer erro ou aviso

```bash
node gsd-tools.cjs roadmap validate
```

---

### `roadmap upgrade --convention milestone-prefixed`

Migra IDs legados `Phase N` para a convenção de prefixo de milestone `Phase M-NN`.

| Flag | Obrigatório | Descrição |
|------|-------------|-----------|
| `--convention milestone-prefixed` | Sim | Convenção alvo para migrar |
| `--apply` | Não | Escreve mudanças no disco (padrão: somente dry-run) |

**Pré-requisitos:** `.planning/ROADMAP.md` existe
**Produz:** Diff de dry-run (padrão) ou reescrita in-place do ROADMAP.md (`--apply`)

```bash
node gsd-tools.cjs roadmap upgrade --convention milestone-prefixed         # dry-run
node gsd-tools.cjs roadmap upgrade --convention milestone-prefixed --apply  # aplicar
```

---

## Comandos de Gerenciamento de Estado

### `state validate`

Detecta desvio entre STATE.md e o sistema de arquivos real.

**Pré-requisitos:** `.planning/STATE.md` existe
**Produz:** Relatório de validação mostrando qualquer desvio entre os campos do STATE.md e a realidade do sistema de arquivos

```bash
node gsd-tools.cjs state validate
```

---

### `state sync [--verify]`

Reconstrói STATE.md a partir do estado real do projeto no disco.

| Flag | Descrição |
|------|-----------|
| `--verify` | Modo dry-run — exibe mudanças propostas sem escrever |

**Pré-requisitos:** Diretório `.planning/` existe
**Produz:** `STATE.md` atualizado refletindo a realidade do sistema de arquivos

```bash
node gsd-tools.cjs state sync             # Reconstrói STATE.md a partir do disco
node gsd-tools.cjs state sync --verify    # Dry-run: exibe mudanças sem escrever
```

---

### `state planned-phase`

Registra transição de estado após a conclusão de plan-phase (Planejado/Pronto para executar).

| Flag | Descrição |
|------|-----------|
| `--phase N` | Número da fase que foi planejada |
| `--plans N` | Número de planos gerados |

**Pré-requisitos:** A fase foi planejada
**Produz:** `STATE.md` atualizado com estado pós-planejamento

```bash
node gsd-tools.cjs state planned-phase --phase 3 --plans 2
```

---

## Comandos da Comunidade

### Hooks da Comunidade

Hooks opcionais de git e sessão disponíveis mediante `hooks.community: true` em `.planning/config.json`. Todos são no-ops a menos que explicitamente habilitados.

| Hook | Finalidade |
|------|-----------|
| `gsd-validate-commit.sh` | Impõe o formato Conventional Commits nas mensagens de commit do git |
| `gsd-session-state.sh` | Rastreia transições de estado de sessão |
| `gsd-phase-boundary.sh` | Impõe verificações de limite de fase |

Habilite com:
```json
{ "hooks": { "community": true } }
```

---

### Convite da Comunidade

Para participar da comunidade GSD no Discord, visite o link no README do GSD ou execute `/gsd-help` e siga o link do Discord exibido lá.

---

## Contribuindo: Padrões de Descrição de Skills

As descrições de skills (o campo `description:` no frontmatter de cada `commands/gsd/*.md`) são
injetadas no prompt de sistema de cada sessão. Para manter o overhead por sessão baixo, as descrições
devem ter no máximo 100 caracteres e não devem duplicar a documentação de flags já em `argument-hint:`.

Um portão de lint impõe o orçamento:

```bash
npm run lint:descriptions
```

A verificação também é executada como parte de `npm test` via `tests/skill-frontmatter-contract.test.cjs`.

---

## Relacionados

- [Referência de Configuração](CONFIGURATION.md)
- [Referência de Ferramentas CLI](CLI-TOOLS.md)
- [Referência de Funcionalidades](FEATURES.md)
- [Índice de documentação](README.md)
