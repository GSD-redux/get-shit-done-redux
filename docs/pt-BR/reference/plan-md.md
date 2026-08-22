# Referência do esquema PLAN.md

Um `PLAN.md` por plano é a unidade executável de trabalho do GSD Core — um documento estruturado que instrui exatamente um agente executor sobre o que construir e como verificar se foi construído corretamente. Esta página documenta sua estrutura. Veja o [índice da documentação](../README.md).

---

## Visão geral

Os planos ficam dentro de diretórios de fase em:

```
.planning/phases/<NN>-<slug>/<NN>-<PP>-PLAN.md
```

Por exemplo: `.planning/phases/03-post-feed/03-02-PLAN.md` (Fase 3, Plano 2).

Os planos são produzidos pelo agente `gsd-planner` (disparado por `/gsd-plan-phase`) e consumidos por `execute-phase`. Uma fase normalmente contém entre um e quatro planos; os planos dentro de uma fase são atribuídos a ondas de execução para que trabalhos independentes sejam executados em paralelo.

---

## Frontmatter YAML

Todo PLAN.md começa com um bloco de frontmatter YAML entre delimitadores `---`.

### Exemplo comentado

```yaml
---
phase: 03-post-feed
plan: 02
type: execute
wave: 2
depends_on: ["03-01"]
files_modified:
  - src/components/PostFeed.tsx
  - src/components/PostCard.tsx
  - src/app/feed/page.tsx
autonomous: true
requirements: ["FEED-01", "FEED-03"]
user_setup: []

must_haves:
  truths:
    - "User can scroll through posts from followed accounts"
    - "Each post shows author avatar, name, timestamp, and content"
    - "Empty state appears when no posts exist"
  artifacts:
    - path: "src/components/PostFeed.tsx"
      provides: "Scrollable post list"
      min_lines: 40
    - path: "src/components/PostCard.tsx"
      provides: "Individual post card"
      exports: ["PostCard"]
  key_links:
    - from: "src/components/PostFeed.tsx"
      to: "/api/feed"
      via: "fetch in useEffect"
      pattern: "fetch.*api/feed"
---
```

### Referência dos campos de frontmatter

| Campo | Obrigatório | Tipo | Finalidade |
|---|---|---|---|
| `phase` | Sim | string | Identificador da fase, ex.: `03-post-feed`. |
| `plan` | Sim | string | Número do plano dentro da fase, ex.: `02`. |
| `type` | Sim | `execute` ou `tdd` | `execute` para planos padrão; `tdd` para planos orientados a testes, onde os testes são escritos antes da implementação. |
| `wave` | Sim | inteiro | Onda de execução. Planos na onda 1 são executados em paralelo (sem dependências). Planos na onda 2 ou superior aguardam a conclusão de todos os planos da onda anterior. Pré-calculado durante o planejamento pelo `gsd-planner`. |
| `depends_on` | Sim | array de IDs de planos | Planos dos quais este plano depende. Array vazio = onda 1. Exemplo: `["03-01"]` significa que este plano é executado após o Plano 01 da Fase 3. |
| `files_modified` | Sim | array de caminhos | Todos os arquivos que este plano cria ou modifica. Usado pelo verificador de planos para detectar conflitos de arquivos na mesma onda e pelo execute-phase para rastreamento de merge. |
| `autonomous` | Sim | booleano | `true` quando todas as tarefas são do tipo `auto`. `false` quando o plano contém alguma tarefa `checkpoint:*` que requer interação humana. |
| `requirements` | Sim | array de IDs | IDs de requisitos do ROADMAP.md que este plano atende. Todo ID de requisito de fase deve aparecer no campo `requirements` de pelo menos um plano. Arrays vazios são um BLOQUEADOR. |
| `user_setup` | Não | array de objetos | Etapas de configuração de serviços externos que o Claude não pode automatizar (criação de conta, recuperação de segredos, configuração de painel). Quando presente, o execute-phase gera um checklist `USER-SETUP.md` para o desenvolvedor. |
| `must_haves` | Sim | objeto | Critérios de verificação orientados ao objetivo final. Veja abaixo. |

---

## Campo `must_haves`

`must_haves` captura o que deve ser observavelmente verdadeiro para que o objetivo da fase seja alcançado. É derivado durante o planejamento e verificado após a execução pelo agente `gsd-verifier`.

### Sub-campos

| Sub-campo | Tipo | Finalidade |
|---|---|---|
| `truths` | array de strings | Comportamentos observáveis do ponto de vista do usuário. Cada um deve ser verificável. Exemplo: `"User can send a message"`, não `"WebSocket library installed"`. |
| `artifacts` | array de objetos | Arquivos que devem existir com implementação substantiva (não stubs). |
| `artifacts[].path` | string | Caminho do arquivo relativo à raiz do projeto. |
| `artifacts[].provides` | string | Qual capacidade este arquivo entrega. |
| `artifacts[].min_lines` | inteiro (opcional) | Contagem mínima de linhas para não ser considerado um stub. |
| `artifacts[].exports` | array de strings (opcional) | Exportações nomeadas esperadas para verificação. |
| `artifacts[].contains` | string (opcional) | Expressão regular ou padrão literal que deve aparecer no arquivo. |
| `key_links` | array de objetos | Conexões críticas entre artefatos — a ligação que faz o sistema funcionar de ponta a ponta. |
| `key_links[].from` | string | Arquivo ou componente de origem. |
| `key_links[].to` | string | Arquivo, endpoint ou módulo de destino. |
| `key_links[].via` | string | Descrição de como eles se conectam (ex.: `fetch in useEffect`, `Prisma query`, `import`). |
| `key_links[].pattern` | string (opcional) | Expressão regular para verificar se a conexão existe no código-fonte. |

---

## Estrutura do corpo

Após o frontmatter, o corpo do plano utiliza blocos no estilo XML lidos pelo agente executor.

### `<objective>`

Declara o que o plano entrega e por que isso importa para o projeto:

```xml
<objective>
Implement the post feed as a scrollable card list.

Purpose: Core display feature for the social feed phase.
Output: PostFeed and PostCard components wired to /api/feed.
</objective>
```

### `<execution_context>`

Lista os arquivos de workflow que o executor lê antes de começar. Sempre inclui o workflow execute-plan; adiciona a referência de checkpoints quando o plano contém tarefas de checkpoint:

```xml
<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>
```

### `<context>`

Referencia os arquivos-fonte que o executor precisa ler. Inclui documentos de planejamento no nível do projeto e quaisquer arquivos-fonte cujos padrões ou tipos o plano deve replicar. Arquivos `SUMMARY.md` de planos anteriores são incluídos apenas quando há uma dependência genuína (tipos importados, decisão compartilhada) — não de forma reflexiva:

```xml
<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@src/components/UserCard.tsx
</context>
```

### `<tasks>`

Contém um ou mais elementos `<task>`. Todo elemento de tarefa deve ter `<name>`, `<files>`, `<read_first>`, `<action>`, `<verify>`, `<acceptance_criteria>` e `<done>` para tarefas do tipo `type="auto"`.

---

## Tipos de tarefa

| Tipo | Uso | Autonomia |
|---|---|---|
| `auto` | Tudo o que o executor pode fazer de forma independente. | Totalmente autônomo. |
| `checkpoint:human-verify` | Verificação visual ou funcional que requer que um humano observe uma UI ou serviço em execução. | Pausa a execução; apresenta ao desenvolvedor; retoma com aprovação. |
| `checkpoint:decision` | Escolhas de implementação que surgiram durante a execução e requerem a contribuição do desenvolvedor. | Pausa a execução; apresenta opções; retoma com a seleção. |
| `checkpoint:human-action` | Etapas manuais verdadeiramente inevitáveis (criação de conta, interação com hardware). Usadas com parcimônia. | Pausa a execução; retoma com confirmação. |

Planos que contêm qualquer tarefa de checkpoint devem definir `autonomous: false` no frontmatter.

---

## Estrutura de tarefa `auto`

```xml
<task type="auto">
  <name>Task 1: Create PostCard component</name>
  <files>src/components/PostCard.tsx</files>
  <read_first>src/components/UserCard.tsx, src/types/post.ts</read_first>
  <action>Create PostCard component accepting a Post prop (id, authorId, content, createdAt,
    reactionCount). Render author avatar using UserAvatar from UserCard pattern. Show timestamp
    using date-fns formatDistanceToNow. Export as named export PostCard.</action>
  <verify>npx tsc --noEmit</verify>
  <acceptance_criteria>
    - src/components/PostCard.tsx exports named export PostCard
    - PostCard.tsx contains "reactionCount" prop usage
    - npx tsc --noEmit exits 0
  </acceptance_criteria>
  <done>PostCard renders post content with author and timestamp</done>
</task>
```

### Campos obrigatórios para tarefas `auto`

| Campo | Regra |
|---|---|
| `<files>` | Todo arquivo que a tarefa cria ou modifica. O executor escreve apenas nesses arquivos. |
| `<read_first>` | Arquivos que o executor deve ler antes de tocar em qualquer coisa — o arquivo sendo modificado, qualquer arquivo de padrão de referência, qualquer arquivo cujos tipos ou convenções devem ser replicados. |
| `<action>` | Instruções concretas com identificadores exatos, caminhos de arquivo, assinaturas de função e valores esperados. Nunca diz "alinhe X com Y" sem especificar o estado-alvo. Nunca contém blocos de código cercados ou implementações completas. |
| `<verify>` | Um comando ou verificação executável que comprova o sucesso da tarefa. Deve distinguir aprovação de falha — `echo "done"` não é válido. |
| `<acceptance_criteria>` | Condições verificáveis: strings verificáveis por grep, códigos de saída de comandos, comportamentos observáveis. Sem linguagem subjetiva ("parece correto", "configurado corretamente"). |
| `<done>` | Uma declaração curta e mensurável do resultado concluído. |

---

## Dimensões de qualidade do plano

O agente `gsd-plan-checker` avalia cada PLAN.md em 12 dimensões antes do início da execução. Um plano que falha em qualquer verificação de severidade BLOQUEADOR é devolvido ao `gsd-planner` para revisão (até 3 iterações):

| Dimensão | O que verifica |
|---|---|
| **1 — Cobertura de Requisitos** | Todo ID de requisito de fase do ROADMAP.md aparece no campo de frontmatter `requirements` de pelo menos um plano e possui tarefa(s) correspondente(s). |
| **2 — Completude das Tarefas** | Toda tarefa `auto` contém todos os campos obrigatórios (`<files>`, `<action>`, `<verify>`, `<acceptance_criteria>`, `<done>`). Nenhum campo vago ou vazio. |
| **3 — Correção de Dependências** | As referências de `depends_on` são válidas, acíclicas e consistentes com os números de onda. Um plano da Onda N depende apenas de planos em ondas < N. |
| **4 — Links Principais Planejados** | Artefatos em `must_haves.key_links` possuem tarefas correspondentes que implementam a ligação — não apenas a criação do artefato. |
| **5 — Sanidade do Escopo** | Os planos permanecem dentro do orçamento de contexto: 2–3 tarefas por plano (4 = aviso, 5+ = BLOQUEADOR), ≤ 8–10 arquivos por plano (15+ = BLOQUEADOR). |
| **6 — Derivação de Verificação** | `must_haves.truths` são comportamentos observáveis pelo usuário, não detalhes de implementação. Artefatos mapeiam para truths. Links principais cobrem a ligação crítica. |
| **7 — Conformidade de Contexto** | Toda decisão `D-NN` do CONTEXT.md é abordada por pelo menos uma tarefa. Nenhuma tarefa implementa nada de `<deferred>`. |
| **7b — Detecção de Redução de Escopo** | As ações das tarefas não reduzem silenciosamente uma decisão bloqueada para um "v1", "stub" ou "melhoria futura" sem entregar o escopo completo da decisão. Sempre é um BLOQUEADOR quando encontrado. |
| **7c — Conformidade de Nível Arquitetural** | As tarefas atribuem capacidades ao nível correto conforme o Mapa de Responsabilidade Arquitetural do RESEARCH.md (quando presente). Capacidades sensíveis à segurança no nível errado são BLOCKEADOREs. |
| **8 — Conformidade Nyquist** | Quando `workflow.nyquist_validation` está habilitado e RESEARCH.md existe, toda tarefa tem um comando de verificação `<automated>`, nenhuma janela consecutiva de 3 tarefas carece de cobertura, e VALIDATION.md está presente. |
| **9 — Contratos de Dados Entre Planos** | Quando planos compartilham pipelines de dados, suas transformações são compatíveis — nenhum plano remove dados que outro plano precisa em sua forma original. |
| **10 — Conformidade com CLAUDE.md** | Os planos respeitam convenções específicas do projeto, padrões proibidos, ferramentas obrigatórias e requisitos de segurança do `./CLAUDE.md`. |
| **11 — Resolução de Pesquisa** | Quando RESEARCH.md existe, sua seção `## Open Questions` está marcada como `(RESOLVED)` antes de o planejamento prosseguir. |
| **12 — Conformidade de Padrões** | Quando PATTERNS.md existe, as tarefas referenciam os padrões analógicos corretos para cada arquivo novo ou modificado. |

---

## Modelo de execução por ondas

Os números de onda são pré-calculados durante o planejamento. O execute-phase agrupa os planos por número de onda e executa os planos de cada onda em paralelo:

```
Wave 1: Plan 01, Plan 02, Plan 03  (all run simultaneously — no dependencies)
Wave 2: Plan 04                    (waits for Wave 1 to complete)
Wave 3: Plan 05                    (waits for Wave 2 to complete)
```

Planos dentro de uma mesma onda que modificam arquivos sobrepostos não devem estar na mesma onda — a Dimensão 3 do verificador de planos sinaliza isso como um BLOQUEADOR.

---

## Saída do plano

Após a execução bem-sucedida de um plano, o executor escreve um SUMMARY.md em:

```
.planning/phases/<NN>-<slug>/<NN>-<PP>-SUMMARY.md
```

O SUMMARY.md é o registro canônico do que foi construído. Planos subsequentes na mesma fase podem referenciá-lo quando há uma dependência genuína em seus tipos ou decisões.

---

## Relacionados

- [Esquema CONTEXT.md](context-md.md)
- [Artefatos de planejamento](planning-artifacts.md)
- [Funcionalidades](../FEATURES.md)
- [Índice da documentação](../README.md)
