# Como projetar uma fase de UI

**Objetivo:** Produzir um contrato de design de UI bloqueado (`UI-SPEC.md`) que fixe decisões de espaçamento, cores, tipografia e textos antes que o planejador escreva as tarefas, prevenindo inconsistências visuais causadas por escolhas de estilo ad-hoc durante a execução.

**Pré-requisitos:** `.planning/ROADMAP.md` deve existir. A fase precisa ter trabalho de frontend ou UI. Executar `/gsd-discuss-phase N` antes é fortemente recomendado — o pesquisador de UI lê `CONTEXT.md` para evitar fazer perguntas sobre decisões que você já tomou.

---

## Decida se esta fase precisa de um contrato de UI

Nem todas as fases precisam de `/gsd-ui-phase`. Use quando:

- A fase introduz novas superfícies de UI (páginas, fluxos, layouts)
- Vários componentes serão construídos e a consistência visual é importante
- Você está iniciando o frontend de um novo projeto e precisa de uma linha de base do sistema de design
- Você está adicionando trabalho significativo de UI a um projeto existente e deseja bloquear tokens, espaçamento e cores antes da execução

Pule quando:

- A fase é puramente de backend, infraestrutura ou dados, sem saída voltada ao usuário
- Um UI-SPEC.md já existe para uma fase anterior e esta fase constrói sobre padrões visuais idênticos sem introduzir novas superfícies

Se não tiver certeza, a trava de segurança irá alertá-lo: quando `workflow.ui_safety_gate` está habilitado (padrão), `/gsd-plan-phase` avisa ao detectar trabalho de frontend sem `UI-SPEC.md` e pergunta se deve executar `/gsd-ui-phase` primeiro.

---

## Execute o contrato de design de UI

```bash
/gsd-ui-phase 2
```

Se nenhum número de fase for fornecido, o GSD Core usa a fase atual como alvo.

O comando é executado em dois estágios:

1. **`gsd-ui-researcher`** — lê `CONTEXT.md`, `RESEARCH.md` e `REQUIREMENTS.md` em busca de decisões existentes, detecta o estado do sistema de design (shadcn `components.json`, configuração do Tailwind, tokens existentes), e faz apenas as perguntas de design não respondidas em cinco áreas: espaçamento, cores, tipografia, textos e segurança do registro.
2. **`gsd-ui-checker`** — valida o `UI-SPEC.md` resultante em sete dimensões. Se problemas forem encontrados, um ciclo de revisão reexecuta o pesquisador (até duas iterações) visando apenas os itens sinalizados.

**Saída:** `{padded_phase}-UI-SPEC.md` em `.planning/phases/{phase-dir}/`.

---

## O que o UI-SPEC cobre

O pesquisador bloqueia decisões em cinco áreas:

| Área | Exemplos |
|---|---|
| **Espaçamento** | Escala base (4px ou 8px), alinhamento de grid, padding de componentes |
| **Cores** | Paleta primária, de destaque e neutra; regra 60/30/10; considerações de modo escuro |
| **Tipografia** | Famílias de fontes, restrições de escala de tamanho/peso, hierarquia de títulos |
| **Textos** | Rótulos de CTA, mensagens de estado vazio, textos de estado de erro, indicadores de carregamento |
| **Segurança do registro** | Protocolo de inspeção de componentes shadcn (veja abaixo) |

O verificador valida a especificação em suas sete dimensões — Textos, Visuais, Cores, Tipografia, Espaçamento, Segurança de Registro e Proveniência do Inventário — retornando PASS, FLAG ou BLOCK para cada uma. (A rubrica de 6 pilares com pontuação de 1 a 4 pertence à auditoria retroativa do `/gsd-ui-review`, não a este verificador.)

---

## Inicialização do shadcn

Para projetos React, Next.js e Vite, o pesquisador oferece inicializar o shadcn se nenhum `components.json` for encontrado. O fluxo:

1. Acesse `ui.shadcn.com/create` e configure seu preset (cores, raio de borda, fontes)
2. Copie a string do preset
3. Execute:

```bash
npx shadcn init --preset <cole aqui>
```

A string do preset torna-se um artefato de planejamento de primeira classe do GSD Core, reproduzível entre fases e marcos.

---

## Trava de segurança do registro

Registros shadcn de terceiros podem injetar código arbitrário. Quando `workflow.ui_safety_gate` está habilitado (padrão), a especificação exige estas etapas antes de instalar qualquer componente não oficial:

```bash
npx shadcn view <component>   # inspect source before installing
npx shadcn diff <component>   # compare against the official registry
```

O verificador sinalizará a especificação como BLOCKED se a segurança do registro não for tratada. Desative a trava via `/gsd-settings` se o seu projeto não usa shadcn ou você tem um processo alternativo de verificação.

---

## Use os achados do sketch como ponto de partida

Se você já executou `/gsd-sketch --wrap-up`, o pesquisador de UI carrega `.claude/skills/sketch-findings-[project]/` automaticamente. Decisões pré-validadas (layout, paleta, tipografia, espaçamento) são tratadas como bloqueadas — o pesquisador não as pergunta novamente. Você verá uma nota no início da execução:

```text
⚡ Sketch findings detected: .claude/skills/sketch-findings-[project]/SKILL.md
   Pre-validated decisions (layout, palette, typography, spacing) should be treated
   as locked — not re-asked.
```

Esta é a principal razão para executar `/gsd-sketch --wrap-up` antes de `/gsd-ui-phase`: transforma a exploração conversacional de design em entrada vinculante para o contrato.

---

## Auditoria visual retroativa com `/gsd-ui-review`

`/gsd-ui-review` é executado após a execução, não antes. Use-o para auditar o frontend implementado em relação ao UI-SPEC (ou em relação aos padrões abstratos de 6 pilares quando nenhuma especificação existir).

```bash
/gsd-ui-review        # audit the current phase
/gsd-ui-review 3      # audit phase 3 specifically
```

Funciona em qualquer projeto com código frontend — a inicialização de projeto GSD não é necessária.

**O que verifica (6 pilares, pontuação de 1 a 4 cada):**

1. Textos — rótulos de CTA, estados vazios, estados de erro
2. Visuais — pontos focais, hierarquia visual, acessibilidade de ícones
3. Cores — disciplina de uso de destaque, conformidade 60/30/10
4. Tipografia — aderência às restrições de tamanho e peso de fonte
5. Espaçamento — alinhamento de grid, consistência de tokens
6. Design de Experiência — cobertura de estados de carregamento, erro e vazio

**Saída:** `{padded_phase}-UI-REVIEW.md` com pontuações e as três principais correções prioritárias. Quando um servidor MCP de navegador como `gsd-browser` estiver configurado, a auditoria também captura capturas de tela com evidências visuais.

**Armazenamento de capturas de tela:** As capturas de tela são salvas em `.planning/ui-reviews/`. Um `.gitignore` é criado automaticamente para evitar que arquivos binários cheguem ao git. As capturas de tela são limpas durante `/gsd-complete-milestone`.

---

## Posição recomendada no ciclo de vida da fase

```text
/gsd-discuss-phase N      ← lock implementation preferences
/gsd-ui-phase N           ← lock design contract (frontend phases)
/gsd-plan-phase N         ← research + plan (reads UI-SPEC.md as context)
/gsd-execute-phase N      ← parallel execution
/gsd-verify-work N        ← manual UAT
/gsd-ui-review N          ← retroactive visual audit (optional but recommended)
```

`/gsd-ui-phase` fica entre discussão e planejamento porque o planejador lê `UI-SPEC.md` como contexto de design — as tarefas em `PLAN.md` referenciam tokens de espaçamento, variáveis de cores e decisões de textos que a especificação bloqueou.

---

## Relacionados

- [Spike e sketch](spike-and-sketch.md)
- [Planejar uma fase](plan-a-phase.md)
- [Comandos](../COMMANDS.md)
- [Índice de documentação](../README.md)
