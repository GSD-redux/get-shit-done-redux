# Referência do esquema STATE.md

`STATE.md` é o arquivo de memória viva do projeto do GSD Core — um único documento Markdown que registra em que ponto o projeto se encontra, o que aconteceu por último e o que executar a seguir. Esta página documenta sua estrutura. Consulte o [índice da documentação](../README.md).

---

## Visão geral

Todo projeto gerenciado pelo GSD Core mantém um único `STATE.md` em `.planning/STATE.md`. Ele é lido no início de todo fluxo de trabalho e escrito após toda ação significativa. O arquivo combina:

- **Frontmatter YAML** — campos legíveis por máquina consumidos pelo hook de linha de status (`parseStateMd`) e pelos comandos `gsd-tools state`.
- **Corpo Markdown** — seções legíveis por humanos cobrindo a posição atual, contexto acumulado, continuidade de sessão e métricas de desempenho.

O arquivo é intencionalmente pequeno (meta: menos de 100 linhas). Ele é um resumo do estado do projeto, não um arquivo histórico.

---

## Frontmatter YAML

O frontmatter aparece entre delimitadores `---` no início do arquivo. Todos os campos, exceto `gsd_state_version` e `status`, são opcionais; os campos podem estar ausentes quando seus dados ainda não estão disponíveis.

### Exemplo comentado

```yaml
---
gsd_state_version: '1.0'
milestone: v2.0
milestone_name: Code Quality
status: executing

# Campos de ciclo de vida de fase — todos opcionais (adicionados na v1.40.0, issue #2833)
active_phase: "4.5"
next_action: execute-phase
next_phases: ["4.5"]

progress:
  total_phases: 17
  completed_phases: 10
  total_plans: 84
  completed_plans: 47
  percent: 59

# Campos adicionais escritos por syncStateFrontmatter
current_phase: "4"
current_phase_name: Observability
current_plan: "3"
last_updated: "2026-06-01T12:34:56.789Z"
state_head: 4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b
last_activity: "2026-06-01"
stopped_at: "Phase 4 P3 execution complete"
paused_at: null
---
```

### Referência de campos

| Campo | Tipo | Quando populado | Finalidade |
|---|---|---|---|
| `gsd_state_version` | string (`'1.0'`) | Sempre | Versão do esquema; escrito na primeira chamada `state.*` por `syncStateFrontmatter`. |
| `milestone` | string (ex.: `v2.0`) | Quando um milestone está configurado | Versão do milestone atual, lida da configuração do projeto. |
| `milestone_name` | string | Quando um milestone está configurado | Rótulo legível do milestone (ex.: `Code Quality`). |
| `status` | string | Sempre | Estágio atual do ciclo de vida. Normalizado por `normalizeStateStatus()` — veja [valores de status](#valores-de-status). |
| `active_phase` | string (ex.: `"4.5"`) | Um comando do orquestrador está em andamento nesta fase | O número da fase atualmente sendo processada. Definido como `null` entre fases. |
| `next_action` | string | Ocioso, com um comando recomendado | O slash command a executar a seguir: `discuss-phase`, `plan-phase`, `execute-phase` ou `verify-phase`. Definido como `null` quando um orquestrador está em andamento ou nenhuma recomendação está disponível. |
| `next_phases` | array YAML flow (ex.: `["4.5"]`) | Acompanha `next_action` | Os IDs de fase aos quais o `next_action` se aplica (tipicamente 1–2 entradas). Definido como `null` nas mesmas condições que `next_action`. |
| `progress.total_phases` | inteiro | Quando dados de fase estão disponíveis | Número total de fases no milestone atual, derivado do ROADMAP.md e do diretório de fases. |
| `progress.completed_phases` | inteiro | Quando dados de fase estão disponíveis | Número de fases que têm todos os resumos de planos em disco (ou seja, todos os planos concluídos). |
| `progress.total_plans` | inteiro | Quando arquivos de plano existem | Soma de todos os arquivos de plano nas fases do milestone atual. |
| `progress.completed_plans` | inteiro | Quando arquivos de resumo existem | Soma dos resumos de planos concluídos (um SUMMARY.md por plano executado). |
| `progress.percent` | inteiro 0–100 | Quando dados de progresso estão disponíveis | Progresso do milestone na **dimensão de fases** (`min(completed_plans/total_plans, completed_phases/total_phases)`). A barra de progresso da linha de status é renderizada somente quando este campo está presente — sua ausência suprime a barra. |
| `current_phase` | string | Quando uma fase está em execução | Número da fase extraído do campo `Current Phase:` do corpo. |
| `current_phase_name` | string | Quando uma fase tem nome | Nome da fase extraído do campo `Current Phase Name:` do corpo. |
| `current_plan` | string | Quando um plano está em andamento | Número do plano extraído do campo `Current Plan:` do corpo. |
| `last_updated` | timestamp ISO-8601 | Sempre (na escrita) | Timestamp da última chamada a `syncStateFrontmatter`; escrito por `realClock.nowIso()`. |
| `state_head` | string (40-char sha) | On write, when the project's own git repo resolves | Full commit sha STATE.md was written against (#2573). Omitted entirely outside a git repo, or when the resolved repo is not the project's own — an unverifiable stamp degrades to absent rather than asserting provenance the file does not have. Recomputed on every write and never carried forward. |
| `last_activity` | string | Quando definido no corpo | Data da última atividade, extraída do campo `Last Activity:` do corpo. |
| `stopped_at` | string | Quando um ponto de parada foi registrado | Descrição da última ação concluída; limitada à seção `## Session` do corpo para evitar correspondência com prosa de arquivo. |
| `paused_at` | string | Quando o projeto está pausado | Descrição de forma livre do ponto de pausa; ausente ou `null` quando não pausado. |

### Valores de status

`normalizeStateStatus()` em `gsd-core/bin/lib/state-document.cjs` mapeia o texto bruto do corpo para estes valores canônicos:

| Valor canônico | Texto correspondente (sem diferenciação de maiúsculas/minúsculas) |
|---|---|
| `discussing` | contém `discussing` |
| `planning` | contém `planning` ou `ready to plan` |
| `executing` | contém `executing`, `in progress` ou `ready to execute` |
| `verifying` | contém `verif` |
| `completed` | contém `complete` ou `done` |
| `paused` | contém `paused` ou `stopped`, ou `paused_at` está presente |
| `unknown` | nenhuma das anteriores |

Quando um comando do orquestrador está em andamento, a convenção (issue #2833) é escrever o estágio do ciclo de vida diretamente em `status`:

| Comando | `status` durante a execução |
|---|---|
| `/gsd-discuss-phase` | `discussing` |
| `/gsd-plan-phase` | `planning` |
| `/gsd-execute-phase` | `executing` |
| `/gsd-verify-work` | `verifying` |

---

## Cenas de renderização da linha de status

`formatGsdState()` em `hooks/gsd-statusline.js` lê o frontmatter analisado e emite a **primeira cena correspondente**. Se nenhum campo novo do ciclo de vida se aplicar, a renderização cai para o formato original byte a byte, inalterado desde a v1.38.x.

| Cena | Gatilho | Exemplo de exibição |
|---|---|---|
| **1. Fase ativa** | `active_phase` está populado | `v2.0 [██░░░░░░░░] 20% · Phase 4.5 executing` |
| **2. Ocioso, próximo recomendado** | `active_phase` é null E tanto `next_action` quanto `next_phases` estão populados | `v2.0 [██░░░░░░░░] 20% · next execute-phase 4.5` |
| **3. Milestone completo** | `percent` é `100` OU `completed_phases == total_phases` | `v2.0 [██████████] 100% · milestone complete` |
| **4. Fallback padrão** | Nenhuma das anteriores corresponde | `v1.9 Code Quality · executing · ph 1/5` (formato existente) |

**Prioridade de cena:** quando `active_phase` e `next_action` estão populados, a Cena 1 prevalece — um orquestrador está em andamento, portanto uma "próxima recomendação" seria enganosa. Essa prioridade é imposta pela ordem de verificação em `formatGsdState()` e coberta pelo conjunto `"scene priority"` em `tests/gsd-statusline.test.cjs`.

A barra de progresso (`[██░░░░░░░░] 20%`) é anexada ao segmento do milestone somente quando `progress.percent` está presente no frontmatter; ausente significa sem barra.

---

## Restrições de análise do frontmatter

O hook de linha de status usa análise baseada em regex (sem biblioteca YAML completa), portanto as seguintes restrições se aplicam. Elas são testadas em `tests/gsd-statusline.test.cjs`.

1. **O frontmatter deve começar no primeiro caractere do arquivo.** Qualquer coisa — incluindo comentários — acima do `---` de abertura invalida a correspondência. A linha `---` de abertura deve ser exatamente isso, sem espaços no final.

2. **Comentários dentro de blocos aninhados não são suportados.** O analisador do bloco `progress:` requer que a próxima linha seja `[ \t]+\w+:`. Inserir um `# comment` entre `progress:` e sua primeira chave quebra a correspondência e a barra desaparece. Qualquer documentação pertence ao corpo do `STATE.md`, não dentro dos blocos do frontmatter.

3. **O formato primário de `next_phases` é flow de linha única.** O analisador tenta primeiro `next_phases: ["4.5", "4.6"]`. Sequências em bloco (`- 4.5\n- 4.6`) também são analisadas, mas são menos confiáveis para renderização da linha de status. Prefira flow de linha única para `next_phases` para manter o analisador baseado em regex previsível. Se muitas fases candidatas precisarem ser registradas para fins de documentação, armazene-as no corpo do `STATE.md`.

Se uma mudança futura substituir o analisador de regex por uma biblioteca YAML completa, essas restrições poderão ser relaxadas e os testes atualizados adequadamente.

---

## Seções do corpo Markdown

O corpo (tudo após o `---` de fechamento) segue o template em `gsd-core/templates/state.md`. As seções padrão são:

### Referência do Projeto

Aponta para `.planning/PROJECT.md`. Contém:
- **Valor central** — a frase de uma linha da seção Core Value do `PROJECT.md`.
- **Foco atual** — qual fase está ativa.

### Posição Atual

Onde o projeto está agora:

| Campo | Formato |
|---|---|
| `Phase:` | `X of Y (Phase name)` |
| `Plan:` | `A of B in current phase` |
| `Status:` | Texto livre, ex.: `Ready to execute`, `Executing Phase 4`, `Phase complete — ready for verification` |
| `Last activity:` | Data ISO (`YYYY-MM-DD`) quando escrito por handler; prosa narrativa quando elaborado pelo executor |
| `Progress:` | Barra visual, ex.: `[████░░░░░░] 40%` |

Os campos `Status:` e `Last activity:` nesta seção são atualizados pelos handlers do GSD quando o valor existente é um padrão de template conhecido (invariante de Knuth: valores elaborados pelo executor são preservados). A lista completa de padrões de handler conhecidos está em `KNOWN_TEMPLATE_DEFAULTS` dentro de `gsd-core/bin/lib/state-document.cjs`.

### Métricas de Desempenho

Rastreamento de velocidade de execução:
- Total de planos concluídos, duração média por plano.
- Tabela de detalhamento por fase (`Phase | Plans | Total | Avg/Plan`).
- Tendência recente: Improving / Stable / Degrading.

Atualizado após cada conclusão de plano.

### Contexto Acumulado

**Decisões** — um resumo das decisões recentes que afetam o trabalho atual (o log completo vive em `PROJECT.md`). Adicionado via `gsd-tools state add-decision`.

**Todos Pendentes** — contagem e referência a `.planning/todos/pending/`. Capturado via `/gsd-capture`.

**Bloqueadores/Preocupações** — problemas que afetam trabalhos futuros, prefixados com a fase de origem. Adicionado via `gsd-tools state add-blocker`; resolvido via `gsd-tools state resolve-blocker`.

### Continuidade de Sessão

Permite retomada instantânea de sessão:
- `Last session:` — timestamp ISO-8601 da última sessão.
- `Stopped at:` — descrição da última ação concluída.
- `Resume file:` — caminho para um arquivo `.continue-here*.md` se existir, caso contrário `None`.

---

## Compatibilidade retroativa

Os campos de ciclo de vida de fase (`active_phase`, `next_action`, `next_phases` e `progress.percent` para a barra) são **aditivos e opt-in por projeto**:

- Um `STATE.md` sem nenhum dos campos de ciclo de vida populados é renderizado **byte a byte de forma idêntica** à v1.38.x e anteriores.
- Adicionar qualquer campo de ciclo de vida é opt-in — o renderizador degrada graciosamente quando os campos estão ausentes.
- A barra de progresso é opt-in mesmo quando o bloco `progress` existe: somente `progress.percent` ativa a barra; `total_phases` e `completed_phases` sozinhos não ativam.

O conjunto de testes `formatGsdState #2833 backward compatibility` em `tests/gsd-statusline.test.cjs` garante essa promessa; qualquer mudança que quebre a renderização legada do `STATE.md` fará o conjunto falhar.

---

## Relacionados

- [Artefatos de planejamento](planning-artifacts.md)
- [Configuração](../CONFIGURATION.md)
- [O ciclo de fases](../explanation/the-phase-loop.md)
- [índice da documentação](../README.md)
