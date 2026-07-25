# Como depurar uma execução com falha

**Objetivo:** Recuperar quando uma execução de fase falha, trava ou produz trabalho incompleto — e retomar de forma limpa sem perder o progresso ou repetir o trabalho que já foi concluído com sucesso.

**Pré-requisitos:** Você executou `/gsd-execute-phase N` e a execução parou antes de gravar `VERIFICATION.md`, ou você vê saída inesperada, arquivos ausentes ou um indicador de progresso travado.

---

## Detectar se a execução travou ou falhou

Antes de tomar qualquer ação de recuperação, determine o que realmente aconteceu.

### Se você ver "Spawning…" sem saída após 1–5 minutos

Isso é normal, não é um travamento. Os subagentes GSD são executados em uma janela de contexto isolada. A nota de atividade na linha de spawn confirma isso. Não interrompa a sessão.

Se já se passaram mais de 10 minutos sem resultado, verifique a barra lateral do Claude Code. Se a tarefa do agente aparecer como concluída mas nenhuma saída tiver aparecido, o resultado pode ter sido perdido em uma troca de contexto — execute novamente o mesmo comando:

```bash
/gsd-execute-phase 1
```

O GSD verifica a existência de arquivos `SUMMARY.md` antes de despachar os executores. Planos que já possuem um são ignorados automaticamente.

### Se a execução parou no meio de uma onda com uma mensagem de erro

Verifique o histórico do git para ver quais planos foram commitados com sucesso:

```bash
git log --oneline -20
```

Planos que commitaram seu trabalho terão uma entrada como `feat(01-02): …`. Planos sem um commit estão incompletos e serão executados novamente quando você executar o comando novamente.

### Se o executor commitou o código mas não gravou SUMMARY.md

O GSD detecta isso na próxima execução e apresenta uma porta de retomada segura com três opções:

- **Fechar manualmente** — inspecione os commits você mesmo, escreva `SUMMARY.md` e execute novamente.
- **Executar novamente do zero** — reverta ou substitua os commits parciais antes de despachar um novo executor.
- **Marcar e pular** — registre a anomalia e continue, apenas com sua confirmação explícita.

---

## Diagnosticar a causa raiz

### Execute `/gsd-debug --diagnose`

Se a execução produziu saída incorreta, código com stubs ou uma falha de verificação, use o modo somente de diagnóstico para investigar sem aplicar nenhuma correção:

```bash
/gsd-debug --diagnose "Phase 2 executor produced stubs instead of real code"
```

`--diagnose` para na causa raiz sem tocar nos seus arquivos. Ele cria um arquivo de sessão em `.planning/debug/<slug>.md` para que você possa retomar a investigação mais tarde, se necessário.

Para iniciar uma sessão de depuração completa que também aplica uma correção:

```bash
/gsd-debug "Login middleware not handling 401 correctly after phase 3"
```

O GSD coleta sintomas, executa uma investigação estruturada usando o método científico e propõe uma correção. Se `tdd_mode: true` estiver definido na sua configuração, ele exige um teste com falha antes de aplicar qualquer correção.

### Verificar sessões de depuração ativas

```bash
/gsd-debug list
```

Mostra todas as sessões abertas com sua hipótese atual e próxima ação. Para retomar uma sessão específica:

```bash
/gsd-debug continue <slug>
```

---

## Executar uma análise post-mortem com `/gsd-forensics`

Se a causa não estiver clara a partir da saída de erro — por exemplo, planos referenciam arquivos inexistentes, a execução produziu resultados inesperados ou o estado parece corrompido — execute uma investigação forense:

```bash
/gsd-forensics "Phase 3 execution stalled after wave 1"
```

O GSD analisa o histórico do git, a completude dos artefatos em `.planning/`, a consistência de STATE.md, o trabalho não commitado e as worktrees órfãs. Ele grava um relatório estruturado em `.planning/forensics/report-<timestamp>.md` e apresenta as etapas de remediação recomendadas.

`/gsd-forensics` é somente leitura — ele nunca modifica os arquivos do seu projeto.

**O que ele detecta:**

- **Loop travado** — o mesmo arquivo aparece em três ou mais commits consecutivos em uma janela de tempo curta (confiança ALTA se as mensagens de commit forem semelhantes)
- **Artefatos ausentes** — uma fase tem commits mas não tem `SUMMARY.md` ou `VERIFICATION.md`
- **Trabalho abandonado** — alterações não commitadas com STATE.md mostrando execução em andamento e o último commit com mais de duas horas de idade
- **Falha ou interrupção** — alterações não commitadas combinadas com um estado de execução ativo e worktrees órfãs
- **Desvio de escopo** — commits recentes tocam arquivos fora do conjunto de arquivos esperado da fase atual

---

## Retomar a execução após a recuperação

Assim que o problema subjacente for resolvido, execute novamente o comando de execução:

```bash
/gsd-execute-phase 1
```

O GSD ignora planos cujo `SUMMARY.md` já existe e despacha executores apenas para os planos restantes.

Se precisar executar novamente apenas uma onda específica:

```bash
/gsd-execute-phase 1 --wave 2
```

---

## Reverter com `/gsd-undo`

Se a execução produziu código que você deseja descartar completamente, reverta usando o manifesto do plano em vez do `git revert` manual:

### Reverter um único plano

```bash
/gsd-undo --plan 03-02
```

Reverte todos os commits do plano `02` da fase `3`. O GSD exibe uma porta de confirmação antes de gravar qualquer alteração.

### Reverter uma fase inteira

```bash
/gsd-undo --phase 03
```

Reverte todos os commits da fase `3`. O GSD verifica se alguma fase subsequente depende desta fase e avisa você antes de prosseguir.

### Selecionar interativamente a partir de commits recentes

```bash
/gsd-undo --last 5
```

Mostra os cinco commits GSD mais recentes e permite que você selecione quais reverter.

---

## Restaurar o contexto da sessão após uma pausa

Se você retornou ao projeto após uma reinicialização de contexto ou uma nova sessão:

```bash
/gsd-resume-work
```

Restaura o contexto completo da sua sessão a partir do último handoff, incluindo a fase atual, bloqueadores e onde a execução parou.

Como alternativa, para ver sua posição atual e avançar automaticamente para o próximo passo correto:

```bash
/gsd-progress --next
```

---

## Relacionados

- [Executar uma fase](execute-a-phase.md)
- [Recuperar e solucionar problemas](recover-and-troubleshoot.md)
- [Comandos](../COMMANDS.md)
- [Índice da documentação](../README.md)
