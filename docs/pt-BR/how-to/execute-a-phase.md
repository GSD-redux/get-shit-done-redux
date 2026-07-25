# Como executar uma fase

**Objetivo:** Executar uma fase planejada por meio de execução paralela em ondas e registrar cada plano como um commit git atômico.

**Pré-requisitos:** A fase deve ter pelo menos um arquivo `PLAN.md`. Se o planejamento ainda não foi concluído, execute `/gsd-plan-phase N` primeiro — consulte [Planejar uma fase](plan-a-phase.md).

---

## Executar a fase completa

```bash
/gsd-execute-phase 1
```

O GSD Core lê os arquivos de plano da fase, agrupa-os em ondas de dependência e cria um agente executor independente por plano. Cada executor confirma seu trabalho atomicamente antes de a próxima onda começar.

Antes de qualquer agente ser despachado, o GSD Core exibe uma tabela de ondas:

```
## Execution Plan

Phase 1: Core middleware — 3 plans across 2 wave(s)

| Wave | Plans          | What it builds            |
|------|----------------|---------------------------|
| 1    | 01-01, 01-02   | Core validation function  |
| 2    | 01-03          | Express middleware wrapper |
```

Os planos da Onda 1 são executados em paralelo (cada um em um worktree git isolado). A Onda 2 aguarda até que todos os commits da Onda 1 sejam mesclados.

Para o modelo de coordenação de agentes subjacente, consulte [Orquestração multi-agente](../explanation/multi-agent-orchestration.md).

---

## Executar uma única onda

Se você quiser executar apenas uma onda — por exemplo, para inspecionar a saída da Onda 1 antes de avançar para a Onda 2 — use `--wave N`:

```bash
/gsd-execute-phase 1 --wave 2
```

O GSD Core executa apenas os planos da Onda 2. Ele primeiro verifica se todas as ondas anteriores estão completas; se algum plano da Onda 1 ainda estiver marcado como incompleto, ele para e solicita que você conclua as ondas anteriores.

---

## Retomar uma execução paralisada

Se a execução parar no meio — um erro de cota, uma queda de rede ou uma sessão travada — o progresso no nível de onda é preservado. O GSD Core verifica a existência de um arquivo `SUMMARY.md` para cada plano; planos que já possuem esse arquivo são ignorados automaticamente ao reexecutar:

```bash
/gsd-execute-phase 1
```

O GSD Core ignorará os planos onde `SUMMARY.md` já existe e retomará a partir do primeiro plano incompleto.

**Se commits existem mas `SUMMARY.md` está ausente** (o executor confirmou o commit mas não escreveu o resumo antes de a sessão encerrar), o GSD Core exibe uma porta de retomada segura e oferece três opções:

- `close out manually` — inspecione os commits, escreva o `SUMMARY.md` e reexecute.
- `re-execute from scratch` — reverta ou substitua os commits parciais antes de despachar um novo executor.
- `mark-and-skip` — registre a anomalia e prossiga, somente com confirmação explícita.

Para diagnóstico sistemático de falhas, consulte [Depurar uma execução com falha](debug-a-failed-execution.md).

---

## Onde os resultados ficam armazenados

Após a conclusão de todas as ondas, o diretório da fase contém:

```
.planning/phases/01-<name>/
  01-01-SUMMARY.md    # O que o plano 01 construiu, arquivos principais, desvios
  01-02-SUMMARY.md
  01-03-SUMMARY.md
  VERIFICATION.md     # Status de aprovação/reprovação por requisito
```

`STATE.md` e `ROADMAP.md` são atualizados automaticamente após a conclusão de todas as ondas. `VERIFICATION.md` é gerado somente quando a fase está totalmente completa.

O histórico git exibirá um commit por tarefa (de cada executor), seguido de commits de rastreamento do orquestrador.

---

## Execução Cross-AI

Para delegar a execução a uma CLI de IA externa (Codex, Gemini, etc.) configurada em `workflow.cross_ai_command`:

```bash
/gsd-execute-phase 2 --cross-ai
```

Para forçar a execução local mesmo quando a execução cross-AI está habilitada na configuração:

```bash
/gsd-execute-phase 2 --no-cross-ai
```

---

## Relacionados

- [Planejar uma fase](plan-a-phase.md)
- [Verificar e publicar](verify-and-ship.md)
- [Depurar uma execução com falha](debug-a-failed-execution.md)
- [Comandos](../COMMANDS.md)
