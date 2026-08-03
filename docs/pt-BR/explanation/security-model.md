# Modelo de segurança do GSD Core

> **Explicação** — Este documento descreve *por que* o GSD Core possui a
> postura de segurança que possui e *como as camadas se articulam*. Não é uma
> referência para todos os parâmetros de hook. Para o comando `/gsd-secure-phase`
> e suas opções, consulte [Comandos](../COMMANDS.md). Para a arquitetura de
> hooks em nível de implementação, consulte
> [Arquitetura § Sistema de Hooks](../ARCHITECTURE.md#hook-system).
> Para a linha de base de segurança organizacional (controles de scanner,
> checklists de incidentes, modelo de responsabilidade), consulte
> [SECURITY.md](../../../SECURITY.md).

---

## Por que o desenvolvimento orientado por IA precisa de uma postura de segurança dedicada

Um editor de código convencional não executa pacotes arbitrários em seu nome.
O GSD Core sim. O pipeline pesquisa → plano → execução automatiza o caminho
completo de "nomear um pacote" até "executar `npm install <package>`", de
"escrever um artefato de planejamento" até "usar esse artefato como prompt de
sistema de um LLM". Cada etapa de automação remove um humano do ciclo — e cada
remoção é uma superfície de ataque potencial.

O modelo de segurança do GSD Core é construído em torno de um princípio
organizador: **defesa em profundidade**. Nenhum controle isolado é assumido
como perfeito. Várias camadas sobrepostas reduzem, cada uma, uma classe distinta
de risco e, juntas, tornam a superfície de ataque substancialmente mais difícil
de explorar sem eliminá-la completamente. O resumo honesto ao final deste
documento explica o que o sistema não consegue proteger.

---

## Camada 1 — Proteção da cadeia de suprimentos: o Package Legitimacy Gate

### A ameaça

Modelos de IA alucinam nomes de pacotes. Este não é um modo de falha marginal:
pesquisas de 2025 documentam aproximadamente 20% das referências de pacotes
geradas por IA como nomes alucinados que não correspondem a pacotes legítimos.
Um subconjunto desses nomes alucinados — aproximadamente 43% na mesma pesquisa —
recorre consistentemente entre prompts, o que significa que um atacante pode
observar quais nomes as ferramentas de IA costumam produzir e pré-registrar
esses nomes no npm, PyPI ou crates.io com scripts de pós-instalação maliciosos.
A técnica é chamada de *slopsquatting*.

A qualidade insidiosa do slopsquatting é que um nome alucinado que passa no
`npm view` *parece legítimo*. A entrada no registro prova apenas que alguém
registrou o nome — não que o pacote faz o que a IA disse que faz, não que
possui usuários legítimos e não que seus scripts de instalação são seguros.
Sem uma barreira, um nome alucinado fluiria sem ser detectado pelo pipeline
pesquisador → planejador → executor do GSD e eventualmente seria executado como
`npm install <attacker-package>` na sua máquina.

### Como a barreira funciona

A barreira opera em três estágios do pipeline:

**Estágio de pesquisa.** Quando `gsd-phase-researcher` recomenda pacotes
externos, executa `gsd-tools query package-legitimacy check --ecosystem <npm|pypi|crates> <pkgs>` para cada um. Os resultados
são gravados em uma tabela `## Package Legitimacy Audit` no `RESEARCH.md`.
Pacotes marcados com `[SLOP]` (alucinação de alta confiança ou registrado por
atacante) são **removidos inteiramente do `RESEARCH.md`** antes de o arquivo
ser salvo. Eles nunca chegam ao planejador.

**Estágio de planejamento.** `gsd-planner` lê a tabela de auditoria. Para
qualquer pacote marcado com `[SUS]` (suspeito: recém-registrado, baixa contagem
de downloads, sem repositório de código-fonte ou padrão de nomenclatura próximo
a um pacote popular) ou `[ASSUMED]` (originado de WebSearch em vez de
verificação direta no registro), o planejador **insere uma tarefa
`checkpoint:human-verify`** antes da etapa de instalação. O checkpoint inclui
um link direto para a página do registro e aspectos específicos a verificar:
histórico do mantenedor, atividade no rastreador de problemas, ausência de
scripts de instalação suspeitos.

**Estágio de execução.** Se uma instalação falhar, `gsd-executor` **exibe um
checkpoint e para**. Ele não tenta silenciosamente um nome de pacote alternativo
— que poderia ser malicioso. Esta é uma regra explícita no comportamento do
executor (RULE 3 na definição do agente executor).

### Por que pacotes do WebSearch são sempre `[ASSUMED]`

Nomes de pacotes descobertos via WebSearch são marcados como `[ASSUMED]`
independentemente de o `npm view` ser bem-sucedido. Um pacote que existe no
registro não é o mesmo que um pacote seguro de instalar. `npm view` prova o
registro, não a legitimidade. A marcação `[ASSUMED]` aciona o mesmo checkpoint
de verificação humana que `[SUS]`, garantindo que qualquer recomendação
descoberta na web e não verificada sempre receba revisão humana antes da
instalação.

### Cobertura por ecossistema

O pesquisador usa comandos de verificação específicos de cada registro, em vez
de uma única verificação genérica:

- Node.js: `npm view`
- Python: `pip index versions`
- Rust: `cargo search`

Isso cobre alucinações entre ecossistemas, que ocorrem em aproximadamente 9%
dos casos de acordo com a pesquisa USENIX de 2025 — situações em que uma IA
recomenda um pacote que existe em um ecossistema, mas não no que está realmente
em uso.

### Degradação graciosa

Se `slopcheck` não estiver disponível (não instalado, ou se a instalação via
pip falhar no momento da pesquisa), o GSD aplica o fallback mais restrito
possível: **todo pacote recomendado é marcado como `[ASSUMED]`**, e o planejador
bloqueia cada instalação com uma tarefa `checkpoint:human-verify`. Pesquisa e
planejamento prosseguem normalmente — o sistema nunca falha irrecuperavelmente
por dependência de ferramenta ausente. Isso é intencionalmente mais restritivo
do que o fluxo normal: a indisponibilidade do slopcheck significa que toda
instalação de pacote recebe um checkpoint humano.

A ferramenta `slopcheck` é licenciada sob MIT e instalável via pip. Se for
descontinuada, o fallback de barreira `[ASSUMED]` garante que a cobertura por
checkpoint humano seja mantida independentemente.

---

## Camada 2 — Defesas contra injeção de prompt

### A ameaça

O GSD Core gera arquivos Markdown que se tornam prompts de sistema de LLMs. O
pipeline de pesquisa lê conteúdo externo da web; o pipeline de planejamento
incorpora texto fornecido pelo usuário (`--text-file`, `--prd`); o pipeline de
execução grava artefatos de planejamento que são relidos posteriormente como
contexto de agente. Qualquer texto controlado pelo usuário que flua para esses
artefatos é um vetor potencial de **injeção indireta de prompt** — uma string
controlada por um atacante que, uma vez dentro de um prompt de sistema, tenta
substituir as instruções do agente ou exfiltrar informações.

### Como as defesas funcionam

O GSD Core trata a injeção de prompt em três níveis.

**Validação de entrada (`security.cjs`).** O módulo
`gsd-core/bin/lib/security.cjs` é o utilitário central de segurança.
Ele fornece:

- Prevenção de path traversal: caminhos de arquivo fornecidos pelo usuário
  (`--text-file`, `--prd`) são validados para resolver dentro do diretório do
  projeto, com resolução explícita do symlink `/var` → `/private/var` no macOS
- Detecção de injeção de prompt: padrões de injeção conhecidos (sobrescritas de
  papel, desvios de instrução, injeções de tag de sistema) são escaneados em
  texto fornecido pelo usuário antes de entrar em qualquer artefato de
  planejamento
- Parsing seguro de JSON: um wrapper que previne ataques de poluição de
  protótipo via payloads JSON manipulados
- Validação de argumentos de shell: argumentos passados a comandos de subshell
  são validados antes do uso

**Hook de runtime: `gsd-prompt-guard.js`.** Este hook é acionado a cada
chamada de Write ou Edit que tem como alvo arquivos `.planning/`. Ele escaneia
o conteúdo sendo gravado em busca dos mesmos padrões de injeção que o
`security.cjs` (um subconjunto inlinado diretamente no hook para independência
— o hook não usa `require()` para carregar o módulo, portanto é executado mesmo
que o caminho do módulo mude). A detecção é **apenas consultiva**: o hook
registra a descoberta, mas não bloqueia a gravação. A justificativa é que um
bloqueio falso-positivo em uma gravação de planejamento legítima seria mais
disruptivo do que uma injeção não detectada em uma camada de varredura
secundária.

**Hook de runtime: `gsd-read-injection-scanner.js`.** Este hook é acionado na
saída de cada chamada da ferramenta Read. Ele escaneia o *conteúdo que acabou
de ser lido* em busca de instruções injetadas em conteúdo não confiável —
capturando casos em que um atacante incorporou instruções em um arquivo que o
GSD está prestes a incorporar ao contexto de um agente.

**Scanner de CI.** `prompt-injection-scan.security.test.cjs` escaneia todos os arquivos
de agente, workflow e comando em busca de vetores de injeção embutidos como
parte do conjunto de testes. Isso detecta tentativas de injeção no próprio
código-fonte do GSD — por exemplo, um ataque de cadeia de suprimentos que
modificou um arquivo de workflow para adicionar uma instrução de sobrescrita de
papel.

### Read Injection Scanner vs Prompt Guard

Os dois hooks cobrem superfícies complementares. `gsd-prompt-guard.js` monitora
*gravações em artefatos de planejamento* — ele detecta injeções sendo plantadas.
`gsd-read-injection-scanner.js` monitora *leituras de qualquer arquivo* — ele
detecta injeções sendo ingeridas a partir de conteúdo externo (o README de uma
dependência, um arquivo de configuração de terceiros, um documento fornecido
pelo usuário). Juntos, eles delimitam o ciclo de vida ingestão → armazenamento
→ releitura.

---

## Camada 3 — Integridade do repositório e das dependências

Acima do comportamento de runtime do GSD, a organização `open-gsd` aplica
controles nos níveis de repositório e pacote. Eles estão documentados
integralmente em [`docs/security/baseline.md`](../../security/baseline.md) e são
resumidos aqui para completude.

**Integridade das dependências.** Todas as dependências de terceiros são
fixadas via `package-lock.json` e verificadas em relação aos checksums
publicados antes da instalação. Uma barreira `scripts/check-npm-integrity.cjs`
detecta versões inválidas, pacotes ausentes e pacotes estranhos no momento do
CI. Isso mitiga ataques de confusão de dependências e typosquatting contra as
próprias dependências do GSD.

**Varredura de segredos.** Cada commit e PR é escaneado em busca de segredos
codificados no código. Fixtures de teste intencionais devem ser anotadas com a
gramática de exclusão padrão do projeto (consulte `SECURITY.md` para o formato
de anotação). Supressões não anotadas falham no CI.

**Varredura de texto com segurança de localidade.** Strings de saída e voltadas
ao usuário são escaneadas em busca de homóglifos Unicode, caracteres de
substituição bidirecional e Unicode invisível — a classe de ataques documentada
na CVE-2021-42574 ("Trojan Source") que pode ocultar conteúdo malicioso em
diffs.

---

## Concessões e limitações

O modelo de segurança descrito aqui reduz significativamente a superfície de
ataque para o desenvolvimento orientado por IA. Ele não elimina o risco da
cadeia de suprimentos.

**O que o Package Legitimacy Gate reduz:** A probabilidade de que um pacote
alucinado ou registrado por um atacante chegue ao `npm install` sem um
checkpoint humano. A barreira `[SLOP]` remove completamente pacotes ruins de
alta confiança; as barreiras `[SUS]` / `[ASSUMED]` exigem revisão humana antes
da execução. Isso eleva substancialmente o custo de um ataque de slopsquatting
bem-sucedido.

**O que o Package Legitimacy Gate não elimina:** Um pacote legítimo que é
comprometido posteriormente (tomada de conta, confusão de dependências em sua
própria árvore) não é detectado pelo portão da API de registro, que verifica sinais de registro
no momento da pesquisa. Lock files e `npm audit` na camada de integridade de
dependências são os controles para essa classe de ataque.

**O que as defesas contra injeção de prompt reduzem:** A probabilidade de que
texto controlado pelo usuário em artefatos de planejamento substitua com sucesso
as instruções do agente. A correspondência de padrões com formas de injeção
conhecidas detecta os casos comuns; jailbreaks novos ou injeções de baixo sinal
podem passar sem ser detectados. A postura apenas consultiva significa que a
detecção é registrada, mas não bloqueada — uma escolha deliberada que preserva
a continuidade do fluxo de trabalho ao custo de não interromper definitivamente
em uma detecção.

**O que as defesas contra injeção de prompt não eliminam:** Uma injeção
suficientemente criativa que não corresponde a padrões conhecidos, ou uma
injeção que chega por um canal que os hooks não cobrem (por exemplo, conteúdo
injetado no README publicado de uma dependência que é lido por um subagente
navegando em documentação). Defesa em profundidade significa que cada camada
torna o ataque mais difícil, não que qualquer camada isolada o torna impossível.

**Reportando vulnerabilidades.** Relate por meio de advisory de segurança
privado do GitHub em
`https://github.com/open-gsd/gsd-core/security/advisories/new`. Não abra
issues públicas. Consulte [SECURITY.md](../../../SECURITY.md) para o cronograma
de resposta e a política de divulgação.

---

## Relacionados

- [Comandos](../COMMANDS.md) — inclui `/gsd-secure-phase` e
  `/gsd-code-review` com flags relevantes para segurança
- [Arquitetura § Sistema de Hooks](../ARCHITECTURE.md#hook-system) —
  detalhes de implementação de cada hook, seu gatilho de evento e propriedades
  de segurança
- [SECURITY.md](../../../SECURITY.md) — reporte de vulnerabilidades, linha de
  base de segurança organizacional, governança de exclusão de varredura de
  segredos e verificação de integridade de dependências
- [Índice de documentação](../README.md)
