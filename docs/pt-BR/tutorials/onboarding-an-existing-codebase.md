# Integrando uma base de código existente

Neste tutorial você integrará o GSD Core a um repositório que já possui código. Você mapeará a base de código, criará um projeto que descreve o que está *adicionando* e executará seu primeiro ciclo de discussão e planejamento para uma mudança pequena e focada. Ao final, o pipeline de planejamento do GSD Core conhecerá sua stack, suas convenções e suas preocupações — e usará esse conhecimento toda vez que planejar.

---

## O que você vai construir

Adicionaremos um único endpoint `GET /health` a uma aplicação Express existente. A mudança é pequena o suficiente para nunca desviar do objetivo real da lição: como o GSD Core aprende sua base de código antes de planejar qualquer coisa.

---

## Pré-requisitos

- **Node.js 18 ou superior** — `node --version` deve exibir `v18.x.x` ou mais recente.
- **Um projeto existente** — qualquer repositório com código. Não precisa ser Express; os passos se aplicam a qualquer stack.
- **Claude Code** — aberto na raiz do seu repositório.

---

## Passo 1 — Instalar o GSD Core

Na raiz do seu repositório:

```bash
npx @opengsd/gsd-core@latest
```

Escolha **Claude Code** e **local** quando solicitado. Você verá:

```text
✓ Installed 86 skills to .claude/commands/
✓ Installed agents to .claude/agents/
✓ GSD Core ready — run /gsd-new-project to start
```

---

## Passo 2 — Iniciar o Claude Code com permissões

```bash
claude --dangerously-skip-permissions
```

> [!CAUTION]
> **The permissions flag is optional.** It skips per-file confirmation while
> GSD's sub-agents read and write files. Use it only in low-stakes or
> throwaway contexts. To keep confirmations enabled, start with `claude` instead.
> For real work, read the [security model](../explanation/security-model.md) first.


---

## Passo 3 — Iniciar o onboarding brownfield

Antes de criar um projeto, deixe o GSD Core inspecionar o estado do repositório e indicar o próximo comando de nível superior seguro. Este passo evita pular contexto de código ou sobrescrever arquivos de planning existentes.

```text
/gsd-onboard
```

Se o onboarding informar que o mapa da base de código está ausente, escolha a opção recomendada e execute o handoff `/gsd-map-codebase` impresso antes de rodar `/gsd-onboard` novamente. `/gsd-onboard --fast` serve para uma primeira passada leve, mas um mapa completo ainda é necessário antes de `/gsd-new-project`. O `/gsd-map-codebase` cria quatro sub-agentes mapeadores paralelos (você verá "Spawning 4 parallel codebase mapper agents…" — isso leva de 1 a 5 minutos; não interrompa). Cada agente foca em uma preocupação diferente:

| Agente | Foco |
|--------|------|
| Tech mapper | Stack, frameworks, dependências |
| Architecture mapper | Padrões, camadas, fluxo de dados |
| Quality mapper | Convenções, práticas de teste |
| Concerns mapper | Dívida técnica, áreas de risco |

Quando os quatro retornarem, você verá:

```text
Codebase mapping complete.

Created .planning/codebase/:
- STACK.md        (47 lines) - Technologies and dependencies
- ARCHITECTURE.md (62 lines) - System design and patterns
- STRUCTURE.md    (38 lines) - Directory layout and organisation
- CONVENTIONS.md  (55 lines) - Code style and patterns
- TESTING.md      (41 lines) - Test structure and practices
- INTEGRATIONS.md (29 lines) - External services and APIs
- CONCERNS.md     (33 lines) - Technical debt and issues
```

Abra `.planning/codebase/STACK.md`. Você verá a linguagem, o runtime, as versões do framework e as dependências principais que o GSD Core detectou — fundamentadas nos arquivos reais que leu, não em suposições.

Abra `.planning/codebase/CONVENTIONS.md`. Você verá as convenções de nomenclatura, os padrões de tratamento de erros e as regras de estilo de código que ele observou no seu código-fonte. Todos os planos que o GSD Core produzir para este repositório seguirão essas convenções automaticamente.

Abra `.planning/codebase/CONCERNS.md`. Este é o arquivo mais útil para ler antes de qualquer trabalho em novo recurso — ele expõe dívidas técnicas e áreas frágeis que podem afetar seus planos.

---

## Passo 4 — Reexecutar o onboarding e inicializar o projeto

Limpe a janela de sessão:

```text
/clear
```

Agora execute `/gsd-onboard` novamente. Se o GSD Core detectar ADRs, PRDs, specs, RFCs ou requisitos de nível raiz, aceite o handoff recomendado para `/gsd-ingest-docs` primeiro e depois rode `/gsd-onboard` de novo. Quando o contexto estiver pronto, o onboarding imprimirá o handoff de inicialização:

```text
/gsd-new-project
```

Como o GSD Core encontrou código existente no passo anterior, `/gsd-new-project` sabe que é um projeto brownfield. As perguntas focam no que você está *adicionando*, não em reconstruir o que já existe:

O GSD Core pergunta o que você quer construir. Responda com o recurso que está adicionando, e não com uma descrição de toda a base de código:

```text
Add a GET /health endpoint to the Express app. It should return
{ "status": "ok", "uptime": <seconds> }. We'll use it for load-balancer
health checks.
```

O GSD Core faz um pequeno número de perguntas de esclarecimento e depois prossegue para a criação de requisitos e roteiro. Como já leu `ARCHITECTURE.md` e `STACK.md`, mapeará as capacidades existentes para a seção **Validated** de `PROJECT.md` automaticamente — você não precisa descrever a superfície de API existente.

Escolha os padrões recomendados para todas as configurações do fluxo de trabalho.

Quando o sub-agente roadmapper retornar, você verá um roteiro proposto. Para uma única mudança pequena, haverá uma fase:

```text
Proposed Roadmap

1 phase | 2 requirements mapped | All v1 requirements covered ✓

| # | Phase          | Goal                                          | Requirements |
|---|----------------|-----------------------------------------------|--------------|
| 1 | Health endpoint| GET /health returning status and uptime JSON  | HLT-01, HLT-02 |
```

Aprove o roteiro.

Execute `/gsd-onboard` mais uma vez depois que a configuração do projeto terminar. Agora que `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md` e `STATE.md` existem, o onboarding cria ou confirma `.planning/onboarding/SUMMARY.md`.

**O que é criado em `.planning/`:**

```text
.planning/
  PROJECT.md          ← descrição do projeto; capacidades existentes em "Validated"
  REQUIREMENTS.md     ← HLT-01, HLT-02
  ROADMAP.md          ← Fase 1, status: pending
  STATE.md            ← memória de sessão
  config.json         ← configurações do fluxo de trabalho
  onboarding/SUMMARY.md ← status do onboarding e próximo comando
  codebase/           ← os sete arquivos de mapa do Passo 3
```

Observe que `.planning/codebase/` já está lá desde o Passo 3. O GSD Core leu esses arquivos ao escrever `PROJECT.md`, por isso conseguiu preencher os requisitos Validated sem que você os descrevesse.

---

## Passo 5 — Limpar o contexto e discutir a Fase 1

```text
/clear
```

```text
/gsd-discuss-phase 1
```

Como o GSD Core leu seu `CONVENTIONS.md` e `ARCHITECTURE.md`, suas perguntas são fundamentadas na sua base de código real — não em conselhos genéricos. Você pode ver:

```text
> Your routes are registered in src/routes/index.js. Should the health
  endpoint live there, or in a dedicated src/routes/health.js?
  A dedicated health.js — keep routes separated.

> Your existing error middleware returns { error: "message" }. Should
  /health use the same shape for error responses?
  Yes, stay consistent.

> Should uptime be calculated from process.uptime() or a stored start time?
  process.uptime() is fine.
```

Quando a discussão encerrar, o GSD Core escreverá:

```text
.planning/phases/01-health-endpoint/CONTEXT.md
```

Abra esse arquivo. A seção `## Implementation Decisions` captura suas respostas. O planejador lerá este arquivo antes de escrever qualquer tarefa — portanto, suas preferências sobre posicionamento de arquivos e formato de resposta aparecerão nos planos, não apenas na discussão.

---

## Passo 6 — Planejar a Fase 1

```text
/gsd-plan-phase 1
```

Quatro sub-agentes de pesquisa rodam em paralelo (1–5 minutos). Quando retornarem, o planejador lê `CONTEXT.md`, os resultados da pesquisa e o mapa da sua base de código para criar planos de tarefas que correspondem às suas convenções.

**O que é criado:**

```text
.planning/phases/01-health-endpoint/
  RESEARCH.md         ← descobertas sobre padrões de health endpoint
  01-01-PLAN.md       ← Tarefa: criar src/routes/health.js
  01-02-PLAN.md       ← Tarefa: registrar rota health em src/routes/index.js
```

Abra `01-01-PLAN.md`. Observe que a tag `<files>` referencia `src/routes/health.js` — exatamente o caminho que você especificou na discussão, consistente com o padrão de roteamento que o GSD Core observou no mapa da sua base de código. Isso é o mapa da base de código em ação.

---

## Próximos passos

Você agora tem um projeto com um mapa da base de código, um registro de decisões de discussão e planos de tarefas verificados — tudo fundamentado no seu código real. A partir daqui, o fluxo de trabalho é idêntico ao de um projeto greenfield:

```text
/gsd-execute-phase 1
/gsd-verify-work 1
/gsd-ship 1
```

Para cada recurso futuro, execute `/gsd-map-codebase` novamente sempre que a estrutura mudar significativamente, para manter o mapa da base de código atualizado.

---

## O que você aprendeu

- Como `/gsd-onboard` sequencia com segurança o setup brownfield sem aninhar comandos interativos ou sobrescrever planning existente.
- Como `/gsd-map-codebase` executa quatro agentes paralelos para produzir `STACK.md`, `ARCHITECTURE.md`, `CONVENTIONS.md`, `CONCERNS.md`, `STRUCTURE.md`, `TESTING.md` e `INTEGRATIONS.md` em `.planning/codebase/`.
- Como `/gsd-new-project` em um repositório brownfield concentra as perguntas no que você está *adicionando* e preenche os requisitos Validated a partir do código existente.
- Como o mapa da base de código orienta cada pergunta em `/gsd-discuss-phase` — caminhos de arquivos, padrões e convenções vêm do seu código real.
- Como o planejador lê `CONTEXT.md` e `CONVENTIONS.md` para produzir planos que correspondem ao estilo do seu repositório.

---

## Relacionados

- [Seu primeiro projeto](your-first-project.md) — o ciclo greenfield completo, da instalação ao PR
- [Mapear base de código via Comandos](../COMMANDS.md) — todos os flags e subcomandos de `/gsd-map-codebase`
- [Índice de documentação](../README.md)
