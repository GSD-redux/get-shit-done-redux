# Como planejar uma fase

**Objetivo:** Transformar decisões de fase e pesquisa em um plano de tarefas atômico e verificável, pronto para execução.

**Pré-requisitos:** `.planning/ROADMAP.md` deve existir. Um `{fase}-CONTEXT.md` gerado pelo `/gsd-discuss-phase` é fortemente recomendado, mas não obrigatório.

---

## Execute o fluxo de planejamento padrão

```bash
/gsd-plan-phase 2
```

Isso executa três estágios em sequência:

1. **Pesquisa** — Um subagente `gsd-phase-researcher` investiga o domínio e escreve `{fase}-RESEARCH.md`.
2. **Planejamento** — Um subagente `gsd-planner` lê o contexto, a pesquisa e os requisitos, e então escreve um ou mais arquivos `{fase}-{N}-PLAN.md`.
3. **Verificação** — Um subagente `gsd-plan-checker` valida a qualidade do plano em oito dimensões e aciona um ciclo de revisão (até três iterações) até que os critérios de qualidade sejam aprovados.

Se nenhum número de fase for fornecido, o GSD Core seleciona a próxima fase não planejada do roadmap.

---

## Pular ou forçar a pesquisa

**Se o domínio for familiar e não houver necessidade de nova pesquisa:**

```bash
/gsd-plan-phase 3 --skip-research
```

**Se o RESEARCH.md já existir, mas você quiser forçar uma atualização:**

```bash
/gsd-plan-phase 3 --research
```

**Se você quiser executar apenas a pesquisa** — escrever o RESEARCH.md e encerrar antes do planejamento:

```bash
/gsd-plan-phase --research-phase 4
```

Se o RESEARCH.md já existir, será solicitado que você atualize, visualize ou pule. Para forçar a atualização sem o prompt:

```bash
/gsd-plan-phase --research-phase 4 --research
```

Para imprimir o RESEARCH.md existente no stdout sem acionar o pesquisador:

```bash
/gsd-plan-phase --research-phase 4 --view
```

Nota: `--research-phase <N>` é uma flag do `/gsd-plan-phase`. Não existe um comando standalone de fase de pesquisa — o comando standalone foi removido em favor desta flag.

---

## Planejar fatias verticais de funcionalidades em vez de camadas horizontais

**Se você quiser tarefas organizadas como fatias finas de ponta a ponta** (UI → API → BD por funcionalidade) em vez de por camada técnica:

```bash
/gsd-plan-phase 1 --mvp
```

Na Fase 1 de um novo projeto sem resumos de fases anteriores, `--mvp` também produz `SKELETON.md` — um Walking Skeleton que cobre o scaffold do projeto, roteamento, uma leitura/escrita real no BD, uma interação real de UI e implantação de desenvolvimento.

É possível persistir o modo MVP para uma fase sem a flag, adicionando `**Mode:** mvp` à entrada daquela fase no ROADMAP.md.

---

## Exigir um teste falho por tarefa que adiciona comportamento

**Se você quiser a aplicação de TDD** — cada tarefa que adiciona comportamento começa com um teste falho antes da implementação:

```bash
/gsd-plan-phase 1 --tdd
```

Combinável com `--mvp`:

```bash
/gsd-plan-phase 1 --mvp --tdd
```

Isso produz fatias verticais onde cada tarefa que adiciona comportamento segue o ciclo RED → GREEN → REFACTOR. O planejador aplica `type: tdd` às tarefas elegíveis (lógica de negócio, endpoints de API, transformações de dados) e usa o `type: execute` padrão para UI, configuração e código de integração.

O modo TDD também pode ser persistido em config:

```bash
node gsd-tools.cjs config-set workflow.tdd_mode true
```

---

## Replanejar usando feedback de revisão cruzada por IA

**Se você executou `/gsd-review --phase N` e um `REVIEWS.md` existe:**

```bash
/gsd-plan-phase 3 --reviews
```

O planejador lê o `REVIEWS.md` e revisa os planos para endereçar o feedback. Não pode ser combinado com `--gaps`.

**Se você quiser um ciclo automatizado** — replanejar e revisar até que não restem preocupações de nível HIGH:

```bash
/gsd-plan-review-convergence 3
```

O ciclo de convergência executa ciclos de planejar → revisar → replanejar → revisar novamente (até três por padrão). Use `--max-cycles N` para substituir o limite máximo.

---

## Fechar lacunas após uma verificação falha

**Se o `VERIFICATION.md` existir com lacunas não resolvidas e você quiser replanejar apenas para essas lacunas:**

```bash
/gsd-plan-phase 3 --gaps
```

A pesquisa é ignorada; o planejador lê as lacunas de verificação diretamente.

---

## Executar uma validação externa de bounce após o planejamento

**Se `workflow.plan_bounce_script` estiver configurado e você quiser validação externa do plano concluído:**

```bash
/gsd-plan-phase 1 --bounce
```

Para pular o bounce mesmo que esteja habilitado em config:

```bash
/gsd-plan-phase 1 --skip-bounce
```

---

## Suprimir confirmações interativas

```bash
/gsd-plan-phase --auto
```

Ignora todos os prompts. Útil em pipelines automatizados. A pesquisa é ignorada se `research_enabled` for false em config.

---

## O que o plano produz

Uma execução bem-sucedida escreve:

| Arquivo | Finalidade |
|---|---|
| `{fase}-RESEARCH.md` | Pesquisa de domínio, auditoria de legitimidade de pacotes, arquitetura de validação |
| `{fase}-VALIDATION.md` | Mapeamento de testes Nyquist — os casos de teste que o plano deve satisfazer (Dimensão 8) |
| `{fase}-{N}-PLAN.md` | Plano de tarefas executável com frontmatter, atribuições de wave e critérios de aceitação |
| `{fase}/SKELETON.md` | Walking Skeleton (modo MVP, apenas Fase 1 de novo projeto) |

Cada PLAN.md contém tarefas com os campos obrigatórios `<read_first>` e `<acceptance_criteria>`. Cada entrada de `<acceptance_criteria>` é verificável como uma asserção de fonte, asserção de comportamento, comando de teste ou saída de CLI — nunca linguagem subjetiva.

Para a referência completa de campos, consulte o [schema do PLAN.md](../reference/plan-md.md).

### Dimensões de qualidade do plano

O `gsd-plan-checker` valida os planos em oito dimensões antes de permitir a execução:

1. Atomicidade das tarefas — cada tarefa abrange uma única preocupação
2. Correção das dependências — a ordenação de waves é consistente
3. Verificabilidade dos critérios de aceitação — nenhum critério subjetivo
4. Completude do `<read_first>` — o arquivo sendo modificado está sempre listado
5. Valores concretos de `<action>` — sem instruções vagas como "alinhar com"
6. `must_haves` derivados do objetivo da fase
7. Cobertura de IDs de requisitos — cada ID de requisito da fase aparece em pelo menos um plano
8. Mapeamento de testes Nyquist — os planos abordam a estratégia de validação no VALIDATION.md

O ciclo de revisão executa até três vezes. Se os critérios de qualidade não forem aprovados após três iterações, o verificador apresenta os problemas remanescentes para revisão manual.

---

## Replanejamento de uma fase encerrada

Se uma fase possui `VERIFICATION.md` com `status: passed`, ela é considerada encerrada. Tentar replanejá-la resulta em erro. Se o encerramento foi incorreto, substitua com `--force`:

```bash
/gsd-plan-phase 2 --force
```

Um aviso é emitido na transcrição e em quaisquer documentos de plano confirmados.

---

## Relacionados

- [Discutir uma fase](discuss-a-phase.md)
- [Executar uma fase](execute-a-phase.md)
- [Schema do PLAN.md](../reference/plan-md.md)
- [Comandos](../COMMANDS.md)
