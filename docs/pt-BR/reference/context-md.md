# Referência do esquema CONTEXT.md

Um `CONTEXT.md` por fase é o mecanismo do GSD Core para capturar decisões de implementação durante `/gsd-discuss-phase`. É a principal entrada upstream para os agentes de pesquisa e planejamento. Esta página documenta sua estrutura. Consulte o [índice de documentação](../README.md).

---

## Visão geral

Toda fase que passou pelo fluxo de trabalho de discussão produz um `CONTEXT.md` em:

```
.planning/phases/<NN>-<slug>/<NN>-CONTEXT.md
```

Por exemplo: `.planning/phases/03-post-feed/03-CONTEXT.md`.

O arquivo é produzido por `write_context` em `gsd-core/workflows/discuss-phase.md` (ou seus caminhos expressos de ingestão de PRD / ADR). Ele nunca é editado manualmente durante a operação normal — o fluxo de trabalho discuss-phase o escreve e os agentes downstream o leem como uma fonte de verdade selada.

---

## Frontmatter

`CONTEXT.md` não possui frontmatter YAML. Os metadados ficam inline no topo do corpo:

```markdown
# Phase [X]: [Name] - Context

**Gathered:** [ISO date]
**Status:** Ready for planning
```

O campo `Status` é sempre `Ready for planning` quando o arquivo é escrito pela primeira vez. Ele não é atualizado após a criação.

---

## Estrutura de blocos

O corpo é dividido em blocos nomeados no estilo XML. Os blocos aparecem em uma ordem fixa e são lidos pelos agentes downstream pelo nome do bloco, não pelo número de linha.

| Bloco | Finalidade | Preenchido por | Consumido por |
|---|---|---|---|
| `<domain>` | Define o limite da fase — o que esta fase entrega e o que está explicitamente fora do escopo. Ancora a barreira de escopo ao longo do planejamento e execução. | `discuss-phase` (do objetivo da fase em ROADMAP.md) | `gsd-planner`, `gsd-plan-checker` (conformidade de escopo) |
| `<spec_lock>` | Presente apenas quando um `*-SPEC.md` foi encontrado pela etapa `check_spec`. Lista contagens de requisitos bloqueados e limites de escopo; os agentes são orientados a ler `SPEC.md` diretamente para requisitos completos. | `discuss-phase` (condicional) | `gsd-planner` (lê SPEC.md em vez de reler os requisitos aqui) |
| `<decisions>` | Decisões de implementação capturadas durante a discussão, identificadas com identificadores `D-NN`. As categorias emergem do que foi realmente discutido, em vez de uma taxonomia fixa. Inclui uma subseção `Claude's Discretion` para áreas que o usuário delegou. | `discuss-phase` (discussão interativa) | `gsd-planner` (decisões bloqueadas devem ser implementadas), `gsd-plan-checker` (conformidade com a Dimensão 7) |
| `<canonical_refs>` | Caminhos relativos completos para cada spec, ADR, documento de funcionalidade ou documento de design relevante para esta fase. Obrigatório — todo CONTEXT.md deve ter esta seção. Os agentes devem ler os arquivos listados antes de planejar ou implementar. | `discuss-phase` (acumulado de refs do ROADMAP.md + referências do usuário durante a discussão + exploração do código) | `gsd-phase-researcher`, `gsd-planner` |
| `<code_context>` | Ativos reutilizáveis, padrões estabelecidos e pontos de integração descobertos durante a etapa `scout_codebase`. Orienta os agentes em direção ao código existente em vez de reimplementar. | `discuss-phase` (exploração do código) | `gsd-planner`, `gsd-phase-researcher` |
| `<specifics>` | Referências concretas do tipo "quero assim", comparações de produtos ou exemplos específicos capturados verbatim durante a discussão. | `discuss-phase` (entrada livre do usuário) | `gsd-planner` |
| `<deferred>` | Ideias que surgiram na discussão mas pertencem a outras fases. Preservadas para não serem perdidas. Inclui uma subseção `Reviewed Todos` quando os todos foram revisados mas não incorporados ao escopo. | `discuss-phase` (redirecionamento de escopo expandido) | Não consumido por agentes automatizados; somente referência humana |

---

## Formato do identificador de decisão

Cada decisão em `<decisions>` carrega um identificador sequencial `D-NN`:

```markdown
### Layout style
- **D-01:** Card-based layout, not timeline or list
- **D-02:** Each card shows: author avatar, name, timestamp, full post content, reaction counts
```

Os identificadores têm escopo por fase. `D-01` na Fase 3 não tem relação com `D-01` na Fase 7. O verificador de planos (Dimensão 7) verifica se cada `D-NN` é atendido por pelo menos uma ação de tarefa nos planos gerados.

---

## Referências canônicas

O bloco `<canonical_refs>` é **obrigatório**. Agentes que o encontram ausente tratam o CONTEXT.md como incompleto e exibem um aviso. As entradas são agrupadas por tópico e contêm um caminho relativo completo mais uma breve declaração do que o arquivo decide ou define:

```markdown
<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Feed display
- `docs/features/social-feed.md` — Feed requirements, post card fields, engagement display rules
- `docs/decisions/adr-012-infinite-scroll.md` — Scroll strategy decision, virtualisation requirements

### Empty states
- `docs/design/empty-states.md` — Empty state patterns, illustration guidelines

</canonical_refs>
```

Quando um projeto não tem specs externas, a seção declara isso explicitamente:

```
No external specs — requirements fully captured in decisions above
```

Menções inline como "ver ADR-019" espalhadas em `<decisions>` são insuficientes; os agentes precisam do caminho completo na seção dedicada.

---

## Relação com o portão de cobertura de decisões

A **Dimensão 7: Conformidade com o Contexto** do verificador de planos impõe um portão de cobertura após o planejamento:

1. Todo identificador `D-NN` em `<decisions>` deve aparecer em pelo menos um `<action>` ou justificativa de tarefa do plano.
2. Nenhuma tarefa pode implementar algo listado em `<deferred>` (expansão de escopo).
3. Áreas de `Claude's Discretion` são isentas desta verificação — o planejador pode escolher livremente.

Um CONTEXT.md cujas decisões sobrevivem aos planos é considerado conforme. Um CONTEXT.md cujas decisões são silenciosamente descartadas ou parcialmente entregues aciona a **Dimensão 7b: Detecção de Redução de Escopo**, que é sempre um BLOQUEADOR.

---

## Integração com SPEC.md

Quando `/gsd-spec-phase` foi executado antes de discutir uma fase, a etapa `check_spec` encontra o arquivo `*-SPEC.md` e ativa o `<spec_lock>`:

```markdown
<spec_lock>
## Requirements (locked via SPEC.md)

**12 requirements are locked.** See `03-SPEC.md` for full requirements, boundaries, and acceptance criteria.

Downstream agents MUST read `03-SPEC.md` before planning or implementing. Requirements are not duplicated here.

**In scope (from SPEC.md):** [copied from SPEC.md Boundaries]
**Out of scope (from SPEC.md):** [copied from SPEC.md Boundaries]

</spec_lock>
```

Quando `<spec_lock>` está presente, `<decisions>` contém apenas decisões de implementação da discussão — o "como", não o "o quê". Os requisitos não são duplicados entre os dois arquivos.

---

## Rodapé

Todo CONTEXT.md termina com um rodapé de identidade:

```markdown
---

*Phase: XX-name*
*Context gathered: [date]*
```

---

## Relacionados

- [Esquema PLAN.md](plan-md.md)
- [Artefatos de planejamento](planning-artifacts.md)
- [Modos de discussão](../workflow-discuss-mode.md)
- [Índice de documentação](../README.md)
