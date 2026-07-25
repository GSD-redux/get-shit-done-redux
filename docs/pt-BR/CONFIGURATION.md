# Referência de Configuração do GSD

Referência completa do esquema para `.planning/config.json`. Para tutoriais de configuração e guias orientados a tarefas, consulte o [índice da documentação](README.md).

> Esquema completo de configuração, controles de fluxo de trabalho, perfis de modelo e opções de ramificação git. Para contexto de funcionalidades, consulte a [Referência de Funcionalidades](FEATURES.md).

---

## Arquivo de Configuração

O GSD armazena as configurações do projeto em `.planning/config.json`. Criado durante `/gsd-new-project`, atualizado via `/gsd-settings`.

### Esquema Completo

```json
{
  "mode": "interactive",
  "granularity": "standard",
  "model_profile": "balanced",
  "model_overrides": {},
  "models": {},
  "dynamic_routing": null,
  "planning": {
    "commit_docs": true,
    "search_gitignored": false,
    "sub_repos": []
  },
  "context": null,
  "workflow": {
    "research": true,
    "plan_check": true,
    "verifier": true,
    "auto_advance": false,
    "nyquist_validation": true,
    "ui_phase": true,
    "ui_safety_gate": true,
    "ui_review": true,
    "node_repair": true,
    "node_repair_budget": 2,
    "research_before_questions": false,
    "discuss_mode": "discuss",
    "max_discuss_passes": 3,
    "skip_discuss": false,
    "human_verify_mode": "end-of-phase",
    "tdd_mode": false,
    "text_mode": false,
    "use_worktrees": true,
    "code_review": true,
    "code_review_depth": "standard",
    "plan_bounce": false,
    "plan_bounce_script": null,
    "plan_bounce_passes": 2,
    "plan_chunked": false,
    "code_review_command": null,
    "cross_ai_execution": false,
    "cross_ai_command": null,
    "cross_ai_timeout": 300,
    "security_enforcement": true,
    "security_asvs_level": 1,
    "security_block_on": "high",
    "post_planning_gaps": true,
    "build_command": null,
    "test_command": null
  },
  "code_quality": {
    "fallow": {
      "enabled": false,
      "scope": "phase",
      "profile": "standard",
      "mcp": false
    }
  },
  "ship": {
    "pr_body_sections": []
  },
  "hooks": {
    "context_warnings": true,
    "workflow_guard": false
  },
  "statusline": {
    "context_position": "end"
  },
  "review": {
    "default_reviewers": null,
    "models": {}
  },
  "parallelization": {
    "enabled": true,
    "plan_level": true,
    "task_level": false,
    "skip_checkpoints": true,
    "max_concurrent_agents": 3,
    "min_plans_for_parallel": 2
  },
  "git": {
    "branching_strategy": "none",
    "create_tag": true,
    "phase_branch_template": "gsd/phase-{phase}-{slug}",
    "milestone_branch_template": "gsd/{milestone}-{slug}",
    "quick_branch_template": null
  },
  "gates": {
    "confirm_project": true,
    "confirm_phases": true,
    "confirm_roadmap": true,
    "confirm_breakdown": true,
    "confirm_plan": true,
    "execute_next_plan": true,
    "issues_review": true,
    "confirm_transition": true
  },
  "safety": {
    "always_confirm_destructive": true,
    "always_confirm_external_services": true
  },
  "project_code": null,
  "agent_skills": {},
  "response_language": null,
  "features": {
    "thinking_partner": false,
    "global_learnings": false
  },
  "learnings": {
    "max_inject": 10
  },
  "intel": {
    "enabled": false
  },
  "claude_md_path": "./CLAUDE.md"
}
```

---

## Configurações Principais

| Configuração | Tipo | Opções | Padrão | Descrição |
|---------|------|---------|---------|-------------|
| `mode` | enum | `interactive`, `yolo` | `interactive` | `yolo` aprova decisões automaticamente; `interactive` confirma em cada etapa |
| `granularity` | enum | `coarse`, `standard`, `fine` | `standard` | Controla a quantidade de fases: `coarse` (3-5), `standard` (5-8), `fine` (8-12) |
| `model_profile` | enum | `quality`, `balanced`, `budget`, `adaptive`, `inherit` | `balanced` | Nível de modelo para cada agente (consulte [Perfis de Modelo](#model-profiles)). `adaptive` foi adicionado conforme [#1713](https://github.com/open-gsd/gsd-core/issues/1713) / [#1806](https://github.com/open-gsd/gsd-core/issues/1806) e resolve da mesma forma que os outros níveis em perfis com reconhecimento de runtime. |
| `runtime` | string | `claude`, `codex`, ou qualquer string | (nenhum) | Runtime ativo para [resolução de perfil com reconhecimento de runtime](#runtime-aware-profiles-2517). Quando definido, os níveis de perfil (opus/sonnet/haiku) resolvem para IDs de modelo nativos do runtime. Atualmente, apenas o caminho de instalação do Codex emite IDs de modelo por agente a partir deste resolvedor; outros runtimes (`opencode`, `gemini`, `qwen`, `copilot`, …) consomem o resolvedor no momento do spawn e ganham suporte a caminho de instalação dedicado em [#2612](https://github.com/open-gsd/gsd-core/issues/2612). Quando não definido (padrão), o comportamento não se altera em relação às versões anteriores. Adicionado na v1.39 |
| `model_profile_overrides.<runtime>.<tier>` | string \| object | substituição de nível por runtime | (nenhum) | Substitui o mapeamento de nível com reconhecimento de runtime para um `(runtime, tier)` específico. O nível é um de `opus`, `sonnet`, `haiku`. O valor é uma string de ID de modelo (por exemplo, `"gpt-5-pro"`) ou `{ model, reasoning_effort }`. Consulte [Perfis com Reconhecimento de Runtime](#runtime-aware-profiles-2517). Adicionado na v1.39 |
| `model_policy.provider` | string | `openai`, `anthropic`, `anthropic-fable`, `google`, `qwen`, `generic` | (nenhum) | Declara o provedor de modelo. Provedores conhecidos (`openai`, `anthropic`, `anthropic-fable`, `google`, `qwen`) desbloqueiam predefinições baseadas em catálogo. `generic` trata todos os IDs de modelo como strings opacas — sem inferência de prefixo, sem padrões de esforço de raciocínio. `model_policy.runtime_tiers` resolve antes do legado `model_profile_overrides`. Consulte [Predefinições de Política de Modelo](#model-policy-presets-model_policy--added-in-v142). Adicionado na v1.42 ([#49](https://github.com/open-gsd/gsd-core/issues/49)) |
| `model_policy.budget` | enum | `high`, `medium`, `low` | (nenhum) | Seleciona um nível de orçamento ao usar um provedor conhecido. O GSD materializa a predefinição de catálogo correspondente em mapeamentos de nível explícitos no momento da resolução. Ignorado quando `provider` é `generic` ou `custom`. Adicionado na v1.42 ([#49](https://github.com/open-gsd/gsd-core/issues/49)) |
| `model_policy.high` | string | ID do modelo | (nenhum) | ID do modelo de nível de custo alto para provedor `generic`/`custom`. Usado quando `provider: "generic"` ou `"custom"`. Adicionado na v1.42 ([#49](https://github.com/open-gsd/gsd-core/issues/49)) |
| `model_policy.medium` | string | ID do modelo | (nenhum) | ID do modelo de nível de custo médio para provedor `generic`/`custom`. Adicionado na v1.42 ([#49](https://github.com/open-gsd/gsd-core/issues/49)) |
| `model_policy.low` | string | ID do modelo | (nenhum) | ID do modelo de nível de custo baixo para provedor `generic`/`custom`. Adicionado na v1.42 ([#49](https://github.com/open-gsd/gsd-core/issues/49)) |
| `model_policy.runtime_tiers.<runtime>.<tier>` | object | `{ model, reasoning_effort? }` | (nenhum) | Entrada de modelo explícita por runtime e por nível. `tier` é um de `opus`, `sonnet`, `haiku` (correspondendo aos nomes de nível de perfil existentes). `reasoning_effort` é encaminhado apenas para runtimes que o suportam; runtimes sem suporte nunca recebem o campo. Tem precedência sobre `model_profile_overrides`. Adicionado na v1.42 ([#49](https://github.com/open-gsd/gsd-core/issues/49)) |
| `models.<phase_type>` | enum | `opus`, `sonnet`, `haiku`, `inherit` | (nenhum) | Nível de modelo por tipo de fase. Seis slots aceitos: `planning`, `discuss`, `research`, `execution`, `verification`, `completion`. Permite ajuste no nível de fase ("Opus para planejamento, Sonnet para o restante") sem precisar conhecer os nomes dos agentes. Resolve entre `model_overrides` (maior) e `model_profile` (menor); consulte [Modelos Por Tipo de Fase](#per-phase-type-models-models--added-in-v140). Adicionado na v1.40 ([#3023](https://github.com/open-gsd/gsd-core/pull/3030)) |
| `dynamic_routing.enabled` | boolean | `true`, `false` | `false` | Chave mestra para [roteamento dinâmico com escalada por nível em falha](#dynamic-routing-with-failure-tier-escalation-dynamic_routing--added-in-v140). Quando `true`, os agentes resolvem para `tier_models[default_tier]` e escalam um nível acima em falha soft detectada pelo orquestrador. Adicionado na v1.40 ([#3024](https://github.com/open-gsd/gsd-core/pull/3031)) |
| `dynamic_routing.tier_models.<tier>` | enum | `opus`, `sonnet`, `haiku` | (nenhum) | Alias de nível para `light`, `standard` ou `heavy`. Usado quando `dynamic_routing.enabled: true`. Adicionado na v1.40 |
| `dynamic_routing.escalate_on_failure` | boolean | `true`, `false` | `true` | Quando `false`, a escalada é desabilitada mesmo se `enabled: true` — cada tentativa usa o nível padrão. Adicionado na v1.40 |
| `dynamic_routing.max_escalations` | integer | `0`, `1`, `2`, … | `1` | Limite máximo de tentativas por invocação de agente. Além do limite, o resolvedor retorna o modelo do nível-limite. Adicionado na v1.40 |
| `project_code` | string | qualquer string curta | (nenhum) | Prefixo para nomes de diretórios de fase (por exemplo, `"ABC"` produz `ABC-01-setup/`). Adicionado na v1.31 |
| `phase_id_convention` | enum | `"milestone-prefixed"`, `null` | `null` | Convenção de nomenclatura para IDs de fase. `null` = IDs numéricos legados (`Phase 1`, `Phase 2`). `"milestone-prefixed"` = IDs globalmente únicos que codificam o marco envolvente (`Phase 1-01`, `Phase 1-02`). Execute `gsd-tools roadmap upgrade --convention milestone-prefixed` para migrar um ROADMAP.md existente. |
| `response_language` | string | código de idioma | (nenhum) | Idioma para respostas dos agentes (por exemplo, `"pt"`, `"ko"`, `"ja"`). Propagado para todos os agentes gerados para consistência de idioma entre fases. Adicionado na v1.32 |
| `context_window` | number | qualquer inteiro | `200000` | Tamanho da janela de contexto em tokens. Defina `1000000` para modelos com contexto de 1M (por exemplo, `claude-fable-5`). Valores `>= 500000` habilitam enriquecimento adaptativo de contexto (leituras completas de SUMMARY.md anteriores, leituras mais profundas de antipadrões). Configurado via `/gsd-config --advanced`. |
| `context_profile` | string | `dev`, `research`, `review` | (nenhum) | Predefinição de contexto de execução que aplica um conjunto pré-configurado de configurações de modo, modelo e fluxo de trabalho para o tipo atual de trabalho. Adicionado na v1.34 |
| `claude_md_path` | string | qualquer caminho de arquivo | `./CLAUDE.md` | Caminho de saída personalizado para o arquivo CLAUDE.md gerado. Útil para monorepos ou projetos que precisam do CLAUDE.md em um local fora da raiz. Padrão é `./CLAUDE.md` na raiz do projeto. Adicionado na v1.36 |
| `claude_md_assembly.mode` | enum | `embed`, `link` | `embed` | Controla como as seções gerenciadas são escritas no CLAUDE.md. `embed` (padrão) incorpora conteúdo entre marcadores GSD. `link` escreve `@.planning/<source-path>` — o Claude Code expande a referência em tempo de execução, reduzindo o tamanho do CLAUDE.md em ~65% em projetos típicos. `link` aplica-se apenas a seções que possuem um arquivo-fonte real; as seções `workflow` e fallback sempre são incorporadas. Substituições por bloco: `claude_md_assembly.blocks.<section>` (por exemplo `claude_md_assembly.blocks.architecture: link`). Adicionado na v1.38 |
| `context` | string | qualquer texto | (nenhum) | String de contexto personalizado injetada em todos os prompts de agente do projeto. Use para fornecer orientações persistentes específicas do projeto (por exemplo, convenções de código, práticas da equipe) que todos os agentes devem conhecer |
| `phase_naming` | string | qualquer string | (nenhum) | Prefixo personalizado para nomes de diretórios de fase. Quando definido, substitui o slug de fase gerado automaticamente (por exemplo, `"feature"` produz `feature-01-setup/` em vez do slug derivado do roadmap) |
| `brave_search` | boolean | `true`/`false` | detectado automaticamente | Substitui a detecção automática de disponibilidade da API Brave Search. Quando não definido, o GSD verifica a variável de ambiente `BRAVE_API_KEY` ou o arquivo `~/.gsd/brave_api_key` |
| `firecrawl` | boolean | `true`/`false` | detectado automaticamente | Substitui a detecção automática de disponibilidade da API Firecrawl. Quando não definido, o GSD verifica a variável de ambiente `FIRECRAWL_API_KEY` ou o arquivo `~/.gsd/firecrawl_api_key` |
| `exa_search` | boolean | `true`/`false` | detectado automaticamente | Substitui a detecção automática de disponibilidade da API Exa Search. Quando não definido, o GSD verifica a variável de ambiente `EXA_API_KEY` ou o arquivo `~/.gsd/exa_api_key` |
| `search_gitignored` | boolean | `true`/`false` | `false` | Alias legado de nível superior para `planning.search_gitignored`. Prefira a forma com namespace; este alias é aceito para compatibilidade retroativa |

> **Nota:** `granularity` foi renomeado de `depth` na v1.22.3. Configurações existentes são migradas automaticamente.

---

## Configurações de Integração

Configuradas interativamente via [`/gsd-config --integrations`](COMMANDS.md#gsd-config). Estas são configurações de *conectividade* — chaves de API e roteamento entre ferramentas — e são mantidas intencionalmente separadas de `/gsd-settings` (controles de fluxo de trabalho).

### Chaves de API de Busca

Os campos de chave de API aceitam um valor string (a própria chave). Também podem ser definidos como os valores especiais `true`/`false`/`null` para substituir a detecção automática de variáveis de ambiente / arquivos `~/.gsd/*_api_key` (comportamento legado, consulte as linhas acima).

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `brave_search` | string \| boolean \| null | `null` | Chave de API Brave Search usada para pesquisa na web. Exibida como `****<últimos-4>` em toda a interface / saída de `config-set`; nunca exibida em texto simples |
| `firecrawl` | string \| boolean \| null | `null` | Chave de API Firecrawl para raspagem profunda. Mascarada na exibição |
| `exa_search` | string \| boolean \| null | `null` | Chave de API Exa Search para busca semântica. Mascarada na exibição |

**Convenção de mascaramento (`gsd-core/bin/lib/secrets.cjs`):** chaves com 8 ou mais caracteres são renderizadas como `****<últimos-4>`; chaves menores são renderizadas como `****`; `null`/vazio é renderizado como `(unset)`. O texto simples é escrito como está em `.planning/config.json` — esse arquivo é o limite de segurança — mas a CLI, tabelas de confirmação, logs e descrições de `AskUserQuestion` nunca exibem o texto simples. Isso se aplica à própria saída do comando `config-set`: `config-set brave_search <chave>` retorna um payload JSON com o valor mascarado.

### Roteamento de CLI para Revisão de Código

`review.models.<cli>` mapeia um sabor de revisor para um comando shell. O fluxo de trabalho de revisão de código usa este comando quando um sabor correspondente é solicitado.

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `review.models.claude` | string | (modelo da sessão) | Comando para revisão com sabor Claude. Usa o modelo da sessão quando não definido |
| `review.models.codex` | string | `null` | Comando para revisão Codex, por exemplo `"codex exec --model gpt-5"` |
| `review.models.gemini` | string | `null` | Comando para revisão Gemini, por exemplo `"gemini -m gemini-2.5-pro"` |
| `review.models.opencode` | string | `null` | Comando para revisão OpenCode, por exemplo `"opencode run --model claude-sonnet-4"` |

O slug `<cli>` é validado contra `[a-zA-Z0-9_-]+`. Slugs vazios ou que contenham caminhos são rejeitados pelo `config-set`.

### Revisores Padrão para `/gsd-review`

Use `review.default_reviewers` para limitar a execução de `/gsd-review` sem flags a um subconjunto de revisores detectados.

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `review.default_reviewers` | string[] \| null | `null` (todos os revisores detectados) | Subconjunto padrão opcional para `/gsd-review` sem flags, por exemplo `["gemini","codex"]`. Precedência: flags de revisor explícitas > `--all` > `review.default_reviewers` > todos detectados. Slugs desconhecidos são ignorados com aviso; slugs conhecidos mas não detectados são ignorados com uma nota informativa; arrays vazios são rejeitados pelo `config-set`. |

Exemplo:

```json
{
  "review": {
    "default_reviewers": ["gemini", "codex"]
  }
}
```

### Injeção de Habilidades de Agente (dinâmica)

`agent_skills.<agent-type>` estende o mapa `agent_skills` documentado abaixo. O slug é validado contra `[a-zA-Z0-9_-]+` — sem separadores de caminho, sem espaços em branco, sem metacaracteres shell. Configurado interativamente via `/gsd-config --integrations`.

---

## Controles de Fluxo de Trabalho

Todos os controles de fluxo de trabalho seguem o padrão **ausente = habilitado**. Se uma chave estiver ausente na configuração, seu padrão é `true`.

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `workflow.research` | boolean | `true` | Investigação de domínio antes de planejar cada fase |
| `workflow.plan_check` | boolean | `true` | Loop de verificação de plano (até 3 iterações) |
| `workflow.verifier` | boolean | `true` | Verificação pós-execução em relação aos objetivos da fase |
| `workflow.auto_advance` | boolean | `false` | Encadeia automaticamente discuss → plan → execute sem parar |
| `workflow.nyquist_validation` | boolean | `true` | Mapeamento de cobertura de testes durante a pesquisa de fase de planejamento |
| `workflow.ui_phase` | boolean | `true` | Gera contratos de design de UI para fases de frontend |
| `workflow.ui_safety_gate` | boolean | `true` | Solicita executar /gsd-ui-phase para fases de frontend durante a fase de planejamento |
| `workflow.ui_review` | boolean | `true` | Executa auditoria de qualidade visual (`/gsd-ui-review`) após execução de fase no modo autônomo. Quando `false`, o passo de auditoria de UI é ignorado. |
| `workflow.node_repair` | boolean | `true` | Reparação autônoma de tarefas em falha de verificação |
| `workflow.node_repair_budget` | number | `2` | Máximo de tentativas de reparo por tarefa com falha |
| `workflow.research_before_questions` | boolean | `false` | Executa pesquisa antes das perguntas de discussão em vez de após |
| `workflow.discuss_mode` | string | `'discuss'` | Controla como `/gsd-discuss-phase` coleta contexto. `'discuss'` (padrão) faz perguntas uma a uma. `'assumptions'` lê a base de código primeiro, gera premissas estruturadas com níveis de confiança e só pede para corrigir o que está errado. Adicionado na v1.28 |
| `workflow.max_discuss_passes` | number | `3` | Número máximo de rodadas de perguntas na fase de discussão antes que o fluxo de trabalho pare de perguntar. Útil em modo headless/automático para evitar loops de discussão infinitos. |
| `workflow.skip_discuss` | boolean | `false` | Quando `true`, `/gsd-autonomous` ignora totalmente a fase de discussão, escrevendo um CONTEXT.md mínimo a partir do objetivo de fase do ROADMAP. Útil para projetos onde as preferências do desenvolvedor estão totalmente capturadas em PROJECT.md/REQUIREMENTS.md. Adicionado na v1.28 |
| `workflow.text_mode` | boolean | `false` | Substitui menus TUI de AskUserQuestion por listas numeradas em texto simples. Necessário para sessões remotas do Claude Code (modo `/rc`) onde menus TUI não são renderizados. Também pode ser definido por sessão com a flag `--text` na fase de discussão. Adicionado na v1.28 |
| `workflow.use_worktrees` | boolean | `true` | Quando `false`, desabilita o isolamento de worktree git para execução paralela. Usuários que preferem execução sequencial ou cujo ambiente não suporta worktrees podem desabilitar isso. Adicionado na v1.31 |
| `workflow.worktree_skip_hooks` | boolean | `false` | Quando `true`, os agentes executores no modo worktree passam `--no-verify` (ignorando hooks de pré-commit) e a validação de hook pós-onda é executada contra o resultado mesclado. Válvula de escape opt-in para projetos cujos hooks não podem ser executados em worktrees de agente. Padrão `false` executa hooks em cada commit (#2924). |
| `workflow.code_review` | boolean | `true` | Habilita os comandos `/gsd-code-review` e `/gsd-code-review --fix`. Quando `false`, os comandos saem com uma mensagem de gate de configuração. Adicionado na v1.34 |
| `workflow.code_review_depth` | string | `standard` | Profundidade de revisão padrão para `/gsd-code-review`: `quick` (somente correspondência de padrão), `standard` (análise por arquivo) ou `deep` (entre arquivos com grafos de importação). Pode ser substituído por execução com `--depth=`. Adicionado na v1.34 |
| `workflow.plan_bounce` | boolean | `false` | Executa script de validação externo nos planos gerados. Quando habilitado, o orquestrador de fase de planejamento encaminha cada PLAN.md pelo script especificado por `plan_bounce_script` e bloqueia em saída diferente de zero. Adicionado na v1.36 |
| `workflow.plan_bounce_script` | string | (nenhum) | Caminho para o script externo invocado na validação de bounce de plano. Recebe o caminho do PLAN.md como primeiro argumento. Obrigatório quando `plan_bounce` é `true`. Adicionado na v1.36 |
| `workflow.plan_bounce_passes` | number | `2` | Número de passagens sequenciais de bounce a executar. Cada passagem alimenta a saída da passagem anterior de volta no validador. Valores maiores aumentam o rigor ao custo de latência. Adicionado na v1.36 |
| `workflow.post_planning_gaps` | boolean | `true` | Relatório unificado de lacunas pós-planejamento (#2493). Após todos os planos serem gerados e commitados, verifica REQUIREMENTS.md e as `<decisions>` de CONTEXT.md em relação a cada PLAN.md no diretório da fase, então imprime uma tabela `Source \| Item \| Status`. Correspondência por limite de palavra (REQ-1 vs REQ-10) e ordenação natural (REQ-02 antes de REQ-10). Não bloqueante — apenas relatório informativo. Defina como `false` para pular o Passo 13e da fase de planejamento. |
| `workflow.plan_review_convergence` | boolean | `false` | Habilita o comando `/gsd-plan-review-convergence`. Desabilitado por padrão — o comando sai com instrução de habilitação quando esta chave é `false`. O comando automatiza o loop manual de plan→review→replan: gera revisores configurados (Codex, Gemini, Claude, OpenCode, Ollama, LM Studio, llama.cpp), conta preocupações HIGH não resolvidas via contrato CYCLE_SUMMARY, replaneja com feedback `--reviews` e repete até convergir ou atingir o número máximo de ciclos. Habilite com `gsd config-set workflow.plan_review_convergence true`. Adicionado na v1.39 |
| `workflow.plan_chunked` | boolean | `false` | Habilita o modo de planejamento em chunks. Quando `true` (ou quando a flag `--chunked` é passada para `/gsd-plan-phase`), o orquestrador divide a única Task de planejamento de longa duração em uma Task curta de esboço seguida de N Tasks curtas por plano (~3-5 min cada). Cada plano é commitado individualmente para resiliência a falhas. Se uma Task travar e o terminal for forçado a fechar, reexecutar com `--chunked` retoma a partir do último plano concluído. Particularmente útil no Windows onde Tasks de longa duração podem travar em stdio. Adicionado na v1.38 |
| `workflow.code_review_command` | string | (nenhum) | Comando shell para integração de revisão de código externa em `/gsd-ship`. Recebe caminhos de arquivos alterados via stdin. Saída diferente de zero bloqueia o fluxo de trabalho de ship. Adicionado na v1.36 |
| `workflow.tdd_mode` | boolean | `false` | Habilita o pipeline TDD como modo de execução de primeira classe. Quando `true`, o planejador aplica agressivamente `type: tdd` a tarefas elegíveis (lógica de negócios, APIs, validações, algoritmos) e o executor impõe a sequência de gate RED/GREEN/REFACTOR. Um ponto de revisão colaborativa ao final da fase verifica a conformidade com o gate. Adicionado na v1.36 |
| `workflow.human_verify_mode` | string | `'end-of-phase'` | Controla os pontos de verificação humana. `'end-of-phase'` (padrão desde #3309) suprime as tasks `checkpoint:human-verify` e incorpora verificações nos blocos `<verify><human-check>` para revisão ao final da fase. `'mid-flight'` restaura as tasks de checkpoint bloqueantes. `checkpoint:decision` e `checkpoint:human-action` não são afetados. Consulte [Referência de Checkpoints](../../gsd-core/references/checkpoints.md#checkpoint_types). |
| `workflow.cross_ai_execution` | boolean | `false` | Delega a execução de fase para uma CLI de IA externa em vez de gerar agentes executores locais. Útil para aproveitar os pontos fortes de um modelo diferente para fases específicas. Adicionado na v1.36 |
| `workflow.cross_ai_command` | string | (nenhum) | Template de comando shell para execução cross-AI. Recebe o prompt de fase via stdin. Deve produzir saída compatível com SUMMARY.md. Obrigatório quando `cross_ai_execution` é `true`. Adicionado na v1.36 |
| `workflow.cross_ai_timeout` | number | `300` | Timeout em segundos para comandos de execução cross-AI. Previne processos externos que não terminam. Adicionado na v1.36 |
| `workflow.ai_integration_phase` | boolean | `true` | Habilita o comando `/gsd-ai-integration-phase`. Quando `false`, o comando sai com uma mensagem de gate de configuração |
| `workflow.auto_prune_state` | boolean | `false` | Quando `true`, poda automaticamente entradas obsoletas de STATE.md nos limites de fase em vez de solicitar confirmação |
| `workflow.pattern_mapper` | boolean | `true` | Executa o agente `gsd-pattern-mapper` entre pesquisa e planejamento para mapear novos arquivos para análogos existentes na base de código |
| `workflow.subagent_timeout` | number | `600` | Timeout em segundos para invocações individuais de subagente. Aumente para fases de pesquisa ou execução de longa duração |
| `executor.stall_detect_interval_minutes` | number | `5` | Minutos entre verificações de travamento do executor enquanto um agente executor está ativo. O orquestrador de fase de execução usa essa cadência para inspecionar commits recentes e evitar espera eterna por um agente silencioso. |
| `executor.stall_threshold_minutes` | number | `10` | Minutos sem conclusão do executor ou atividade de commit no branch esperado antes que a fase de execução ofereça opções de recuperação para um possível executor travado. |
| `workflow.inline_plan_threshold` | number | `3` | Número máximo de tasks em uma fase antes que o planejador gere um arquivo PLAN.md separado em vez de incorporar tasks no prompt |
| `workflow.drift_threshold` | number | `3` | Número mínimo de novos elementos estruturais (novos diretórios, exportações barrel, migrações, módulos de rota) introduzidos durante uma fase antes que o gate de deriva pós-execução da base de código tome ação. Consulte [#2003](https://github.com/open-gsd/gsd-core/issues/2003). Adicionado na v1.39 |
| `workflow.drift_action` | string | `warn` | O que fazer quando `workflow.drift_threshold` é excedido após `/gsd-execute-phase`. `warn` imprime uma mensagem sugerindo `/gsd-map-codebase --paths …`; `auto-remap` gera `gsd-codebase-mapper` com escopo para os caminhos afetados. Adicionado na v1.39 |
| `workflow.build_command` | string | (nenhum) | Comando shell para compilar o projeto no gate de build pós-merge (Passo A do passo 5.6 na fase de execução). Quando não definido, o gate detecta automaticamente: Xcode (`.xcodeproj` presente) → `xcodebuild build`, `Makefile` com alvo `build:` → `make build`, Justfile → `just build`, `Cargo.toml` → `cargo build`, `go.mod` → `go build ./...`, Python → `python -m py_compile`, `package.json` com script `build` → `npm run build`. Executa com timeout de 5 minutos; falha incrementa `WAVE_FAILURE_COUNT`. Adicionado na v1.39 |
| `workflow.test_command` | string | (nenhum) | Comando shell para executar a suíte de testes do projeto no gate de teste pós-merge (Passo B do passo 5.6 na fase de execução) e no gate de regressão. Quando não definido, o gate detecta automaticamente: Xcode (`.xcodeproj` presente) → `xcodebuild test`, `Makefile` com alvo `test:` → `make test`, Justfile → `just test`, `package.json` → `npm test`, `Cargo.toml` → `cargo test`, `go.mod` → `go test ./...`, Python → `python -m pytest`. Executa com timeout de 5 minutos; falha incrementa `WAVE_FAILURE_COUNT`. Adicionado na v1.39 |

## Configurações de Qualidade de Código

O namespace `code_quality.*` controla ferramentas opcionais de análise estrutural que complementam `/gsd-code-review`. As configurações são aditivas: cada ferramenta é habilitada independentemente e está desativada por padrão.

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `code_quality.fallow.enabled` | boolean | `false` | Habilita a pré-passagem estrutural fallow para `/gsd-code-review`. Quando `false`, nenhuma sondagem de binário fallow ou artefato JSON é produzido. |
| `code_quality.fallow.scope` | string | `phase` | Escopo para análise fallow: `phase` (escopo de arquivo de revisão atual) ou `repo` (repositório inteiro). |
| `code_quality.fallow.profile` | string | `standard` | Seletor de perfil fallow passado para o executor de pré-passagem (`minimal`, `standard`, `strict`). |
| `code_quality.fallow.mcp` | boolean | `false` | **Reservado — ainda não implementado.** Quando `true`, habilita o modo de descobertas estruturais suportadas por MCP para runtimes que suportam roteamento de servidor MCP. Definir como `true` atualmente é um no-op e emite um aviso de runtime. |

## Configurações de Ship

`ship.pr_body_sections` adiciona seções adicionais ao corpo do PR para conteúdo de PRD/corpo do PR específico do projeto em `/gsd-ship` sem editar `gsd-core/workflows/ship.md`.

Para um guia do usuário com exemplos de integração e solução de problemas, consulte [Seções Personalizadas do Corpo do PR](../ship-pr-body-sections.md).

Esta lista é apenas para adição: as entradas configuradas são adicionadas após as seções principais de `Summary`, `Changes`, `Requirements Addressed`, `Verification` e `Key Decisions`. Elas não podem substituir, remover ou reordenar as seções obrigatórias.

Os usos recomendados para PRD ágil/lean incluem histórias de usuário, critérios de aceitação, Definição de Pronto ou critérios de lançamento, riscos e dependências, métricas de sucesso e notas de revisão de stakeholders. Mantenha essas seções curtas e orientadas a evidências para que o corpo do PR permaneça um artefato vivo de lançamento em vez de um dump estático de requisitos.

Cada entrada suporta:

| Campo | Tipo | Padrão | Descrição |
|-------|------|---------|-------------|
| `heading` | string | obrigatório | Título de seção Markdown renderizado como `## {heading}`. Deve ser uma única linha. |
| `enabled` | boolean | `true` | Quando `false`, a integração pode manter uma seção candidata na configuração sem renderizá-la em corpos de PR gerados. |
| `source` | string | (nenhum) | Cadeia de fallback opcional de títulos de artefatos de planejamento, como `PLAN.md ## Risks \|\| VERIFICATION.md ## Manual Checks`. Os artefatos permitidos são `ROADMAP.md`, `PLAN.md`, `SUMMARY.md`, `VERIFICATION.md`, `STATE.md`, `REQUIREMENTS.md` e `CONTEXT.md`. |
| `template` | string | (nenhum) | Markdown literal com tokens fechados: `{phase_number}`, `{phase_name}`, `{phase_dir}`, `{base_branch}`, `{padded_phase}`. |
| `fallback` | string | (nenhum) | Markdown literal usado quando `source` não produz conteúdo e nenhum `template` é fornecido. |

Pelo menos um de `source`, `template` ou `fallback` é obrigatório para cada seção. O padrão é `[]`, portanto projetos existentes mantêm sua saída atual de `/gsd-ship` até que a integração adicione entradas habilitadas.

Exemplo:

```json
{
  "ship": {
    "pr_body_sections": [
      {
        "heading": "User Stories & Acceptance Criteria",
        "enabled": true,
        "source": "REQUIREMENTS.md ## User Stories || REQUIREMENTS.md ## Acceptance Criteria",
        "fallback": "- Acceptance criteria are covered by the linked requirements and verification evidence."
      },
      {
        "heading": "Risks & Rollback",
        "enabled": true,
        "source": "PLAN.md ## Risks || PLAN.md ## Rollback",
        "fallback": "- Rollback: revert this PR."
      },
      {
        "heading": "Stakeholder Sign-off",
        "enabled": false,
        "template": "- Product owner: pending for {phase_name}"
      }
    ]
  }
}
```

### Combinações Comuns de Configurações

As seguintes combinações de `mode`, `granularity`, `model_profile` e controles de fluxo de trabalho são frequentemente usadas juntas. Consulte [Configurar perfis de modelo](how-to/configure-model-profiles.md) para orientação de configuração.

| Cenário | mode | granularity | profile | research | plan_check | verifier |
|----------|------|-------------|---------|----------|------------|----------|
| Prototipagem | `yolo` | `coarse` | `budget` | `false` | `false` | `false` |
| Desenvolvimento normal | `interactive` | `standard` | `balanced` | `true` | `true` | `true` |
| Lançamento em produção | `interactive` | `fine` | `quality` | `true` | `true` | `true` |

---

## Configurações de Planejamento

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `planning.commit_docs` | boolean | `true` | Define se os arquivos de `.planning/` são commitados no git |
| `planning.search_gitignored` | boolean | `false` | Adiciona `--no-ignore` em buscas amplas para incluir `.planning/` |
| `planning.sub_repos` | array de strings | `[]` | Caminhos de sub-repositórios aninhados relativos à raiz do projeto. Quando definido, as ferramentas com reconhecimento de GSD limitam a busca de fase, resolução de caminho e operações de commit por sub-repo em vez de tratar o repositório externo como um monorepo |

### Resolução da Raiz do Projeto em Workspaces Multi-Repositório

Quando `sub_repos` está definido e `gsd-tools.cjs` ou `gsd-tools query` é invocado de dentro de um repositório filho listado, ambas as CLIs sobem até o workspace pai que possui `.planning/` antes de despachar os manipuladores. Ordem de resolução (verificada em cada ancestral até 10 níveis, nunca acima de `$HOME`):

1. Se o diretório inicial já possui seu próprio `.planning/`, ele é a raiz do projeto (sem subida).
2. O pai possui `.planning/config.json` listando o segmento de nível superior do diretório inicial em `sub_repos` (ou o formato legado `planning.sub_repos`).
3. O pai possui `.planning/config.json` com `multiRepo: true` legado e o diretório inicial está dentro de um repositório git.
4. O pai possui `.planning/` e um ancestral até o pai candidato contém `.git` (fallback heurístico).

Se nenhum corresponder, o diretório inicial é retornado sem alteração. `--project-dir /caminho/para/workspace` explícito é idempotente sob esta resolução.

### Detecção Automática

Se `.planning/` estiver em `.gitignore`, `commit_docs` é automaticamente `false` independentemente do config.json. Isso evita erros do git.

---

## Configurações de Hook

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `hooks.context_warnings` | boolean | `true` | Exibe avisos de uso da janela de contexto via hook do monitor de contexto |
| `hooks.workflow_guard` | boolean | `false` | Avisa quando edições de arquivo ocorrem fora do contexto do fluxo de trabalho GSD (aconselha usar `/gsd-quick` ou `/gsd-fast`) |
| `statusline.show_last_command` | boolean | `false` | Acrescenta o sufixo `last: /<cmd>` à statusline mostrando o comando slash invocado mais recentemente. Opt-in; lê a transcrição da sessão ativa para extrair a última tag `<command-name>` (fecha #2538) |
| `statusline.context_position` | string | `"end"` | Posição do medidor de janela de contexto. `"end"` (padrão) renderiza no final da linha; `"front"` renderiza imediatamente após o nome do modelo para que o medidor permaneça visível em terminais estreitos. Fecha #2937 |

O hook guardião de injeção de prompt (`gsd-prompt-guard.js`) está sempre ativo e não pode ser desabilitado — é uma funcionalidade de segurança, não um controle de fluxo de trabalho.

### Configuração de Planejamento Privado

Quando `planning.commit_docs` é `false` e `.planning/` está listado em `.gitignore`, o GSD trata os artefatos de planejamento como locais apenas. `planning.search_gitignored: true` garante que buscas amplas ainda incluam o diretório `.planning/` nesta configuração. Consulte [Configurar planejamento privado](how-to/configure-model-profiles.md) para os passos de configuração.

---

## Injeção de Habilidades de Agente

Injeta arquivos de habilidades personalizados nos prompts de subagentes GSD. As habilidades são lidas pelos agentes no momento do spawn, fornecendo instruções específicas do projeto além do que o CLAUDE.md oferece.

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `agent_skills` | object | `{}` | Mapa de tipos de agente para caminhos de diretório de habilidades |

### Configuração

Adicione uma seção `agent_skills` em `.planning/config.json` mapeando tipos de agente para arrays de caminhos de diretório de habilidades (relativos à raiz do projeto):

```json
{
  "agent_skills": {
    "gsd-executor": ["skills/testing-standards", "skills/api-conventions"],
    "gsd-planner": ["skills/architecture-rules"],
    "gsd-verifier": ["skills/acceptance-criteria"]
  }
}
```

Cada caminho deve ser um diretório contendo um arquivo `SKILL.md`. Os caminhos são validados para segurança (sem travessia fora da raiz do projeto).

### Tipos de Agente Suportados

Qualquer tipo de agente GSD pode receber habilidades. Tipos comuns:

- `gsd-executor` -- executa planos de implementação
- `gsd-planner` -- cria planos de fase
- `gsd-checker` -- verifica a qualidade do plano
- `gsd-verifier` -- verificação pós-execução
- `gsd-researcher` -- pesquisa de fase
- `gsd-project-researcher` -- pesquisa de novo projeto
- `gsd-debugger` -- agentes de diagnóstico
- `gsd-codebase-mapper` -- análise da base de código
- `gsd-advisor` -- consultores da fase de discussão
- `gsd-ui-researcher` -- criação de contrato de design de UI
- `gsd-ui-checker` -- verificação de especificação de UI
- `gsd-roadmapper` -- criação de roadmap
- `gsd-synthesizer` -- síntese de pesquisa

### Como Funciona

No momento do spawn, os fluxos de trabalho chamam `gsd-tools query agent-skills <type>` (ou o legado `node gsd-tools.cjs agent-skills <type>`) para carregar as habilidades configuradas. Se existirem habilidades para o tipo de agente, elas são injetadas como um bloco `<agent_skills>` no prompt de Task():

```xml
<agent_skills>
Read these user-configured skills:
- @skills/testing-standards/SKILL.md
- @skills/api-conventions/SKILL.md
</agent_skills>
```

Se nenhuma habilidade estiver configurada, o bloco é omitido (zero overhead).

### CLI

Defina habilidades via CLI:

```bash
gsd-tools query config-set agent_skills.gsd-executor '["skills/my-skill"]'
```

---

## Feature Flags

Ative capacidades opcionais via o namespace de configuração `features.*`. Feature flags têm padrão `false` (desabilitado) — habilitar uma flag ativa o novo comportamento sem afetar os fluxos de trabalho existentes.

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `features.thinking_partner` | boolean | `false` | Habilita análise de parceiro de raciocínio em pontos de decisão do fluxo de trabalho |
| `features.global_learnings` | boolean | `false` | Habilita o pipeline de aprendizados entre projetos (cópia automática na conclusão de fase, injeção no planejador) |
| `learnings.max_inject` | number | `10` | Número máximo de aprendizados entre projetos injetados em cada prompt do planejador. Valores menores reduzem o tamanho do prompt; valores maiores fornecem contexto histórico mais amplo |
| `intel.enabled` | boolean | `false` | Habilita o sistema de inteligência consultável da base de código. Quando `true`, os comandos `/gsd-map-codebase --query` constroem e consultam um índice JSON em `.planning/intel/`. Adicionado na v1.34 |

<a id="plan-review-settings"></a>
### Configurações de Revisão de Plano

O namespace `plan_review.*` controla o guardião de deriva de plano, que verifica se os símbolos citados nos planos gerados (decoradores, classes, funções, flags CLI) realmente existem no código-fonte no momento da revisão. Isso detecta nomes alucinados antes que a execução comece.

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `plan_review.source_grounding` | boolean | `true` | Habilita o guardião de deriva de plano. Quando `true` (padrão), a revisão de plano resolve cada referência de símbolo citada em um PLAN.md em relação à árvore de fontes ativa. Planos que citam uma função, classe, decorador ou flag CLI inexistente produzem um aviso `needs-acknowledgement` antes do plano ser aprovado. Desabilite com `false` para ignorar completamente a verificação de símbolo. Ative durante a configuração (`/gsd:new-project`) ou a qualquer momento via `/gsd:settings`. |
| `plan_review.source_grounding_authority` | enum | `grep` | Seleciona o adaptador de resolução usado para verificar a existência de símbolos. Valores permitidos: `grep` (padrão — busca ripgrep/grep de arquivos de fonte, funciona em qualquer projeto sem ferramental adicional), `intel` (consulta o índice `.planning/intel/api-map.json` construído por `/gsd:map-codebase`; requer `intel.enabled: true`), `treesitter` (reservado para adaptador tree-sitter futuro), `lsp` (reservado para adaptador LSP futuro), `scip` (reservado para adaptador SCIP/LSIF futuro). Use `intel` quando tiver executado `/gsd:map-codebase` e quiser a busca mais rápida e pré-indexada. Todos os outros valores além de `grep` e `intel` são reservados e não têm efeito na versão atual. |

<a id="graphify-settings"></a>
### Configurações do Graphify

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `graphify.enabled` | boolean | `false` | Habilita o grafo de conhecimento do projeto. Quando `true`, `/gsd-graphify` constrói e consulta um grafo em `.planning/graphs/`. Adicionado na v1.36 |
| `graphify.build_timeout` | number (segundos) | `300` | Segundos máximos permitidos para uma execução de `/gsd-graphify build` antes de abortar. Adicionado na v1.36 |
| `graphify.auto_update` | boolean | `false` | **Opt-in (issue #3347).** Quando `true` (e `graphify.enabled` também é `true`), o hook PostToolUse incluído `hooks/gsd-graphify-update.sh` reconstrói automaticamente o grafo de conhecimento do projeto em um processo em segundo plano após `git commit/merge/pull/rebase --continue/cherry-pick` no branch padrão (substituição `git.base_branch`, senão `main`/`master`/`trunk`). O hook retorna instantaneamente; a reconstrução atualiza `.planning/graphs/{graph.json,graph.html,GRAPH_REPORT.md}` e escreve `.planning/graphs/.last-build-status.json` (`{ts, status: "running"\|"ok"\|"failed", exit_code, duration_ms, head_at_build}`). Bloqueado por PID, ciente de CI (`$CI` env suprime), aborta silenciosamente se `graphify` não estiver no `PATH`. Padrão `false` para que o comportamento existente não mude após atualização. |

#### Configuração para múltiplos desenvolvedores

Quando vários desenvolvedores reconstroem o grafo no mesmo repositório, `graphify hook install` (executado uma vez por clone) instala um driver de merge git que mescla por união gravações concorrentes de `graph.json`, eliminando marcadores de conflito. Também registra o hook de reconstrução pós-commit, escreve `.gitattributes` e adiciona `graphify merge-driver` em `.git/config`. Projetos solo podem pular esta etapa. Introduzido upstream no graphify v0.7.0 junto com o sinal de atualidade `built_at_commit` exibido por `/gsd-graphify status`.

#### Obsolescência baseada em commit

`/gsd-graphify status` relata dois sinais ortogonais de obsolescência:

- **`stale`** (baseado em mtime, janela de 24 horas) — quando o arquivo do grafo foi gravado pela última vez. Útil quando graphify não é executado automaticamente.
- **`commit_stale`** (baseado em commit, requer graphify v0.7+) — se o grafo foi construído contra o `git HEAD` atual. Confiável quando presente.
  Tri-estado: `true` / `false` / `null`. `null` significa que o sinal não está disponível (grafo pré-v0.7, sem git ou commit inacessível) — use o flag de mtime como fallback.

Um grafo construído por CI há alguns minutos contra um checkout antigo aparecerá como atualizado pelo mtime mas `commit_stale: true`. Apresente ambos ao responder perguntas de arquitetura.

### Uso

```bash
# Habilitar uma feature
gsd-tools query config-set features.global_learnings true

# Desabilitar uma feature
gsd-tools query config-set features.thinking_partner false
```

O namespace `features.*` é um padrão de chave dinâmico — novos feature flags podem ser adicionados sem modificar `VALID_CONFIG_KEYS`. Qualquer chave correspondente a `features.<name>` é aceita pelo sistema de configuração.

---

## Configurações de Paralelização

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `parallelization` | boolean | `true` | Atalho para `parallelization.enabled`. Definir `parallelization false` desabilita a execução paralela sem alterar outras sub-chaves |
| `parallelization.enabled` | boolean | `true` | Executa planos independentes simultaneamente |
| `parallelization.plan_level` | boolean | `true` | Paraleliza no nível do plano |
| `parallelization.task_level` | boolean | `false` | Paraleliza tasks dentro de um plano |
| `parallelization.skip_checkpoints` | boolean | `true` | Ignora checkpoints durante execução paralela |
| `parallelization.max_concurrent_agents` | number | `3` | Máximo de agentes simultâneos |
| `parallelization.min_plans_for_parallel` | number | `2` | Mínimo de planos para acionar execução paralela |

> **Hooks de pré-commit e execução paralela**: Quando a paralelização está habilitada, os agentes executores fazem commit com `--no-verify` para evitar contenda de bloqueio de build (por exemplo, disputas de cargo lock em projetos Rust). O orquestrador valida os hooks uma vez após cada onda concluir. Gravações em STATE.md são protegidas por bloqueio no nível do arquivo para evitar corrupção por escrita concorrente. Se você precisar que os hooks sejam executados por commit, defina `parallelization.enabled: false`.

---

## Frontmatter do STATE.md (Ciclo de Vida de Fase)

`STATE.md` carrega frontmatter YAML que o hook da linha de status lê a cada renderização. A v1.40 adiciona quatro campos opcionais de ciclo de vida de fase lidos por `parseStateMd()` e renderizados por `formatGsdState()`:

| Campo | Tipo | Finalidade |
|-------|------|---------|
| `active_phase` | string (por exemplo `"4.5"`) | Número de fase quando um comando orquestrador está em execução |
| `next_action` | string | Próximo comando recomendado quando inativo (`discuss-phase` / `plan-phase` / `execute-phase` / `verify-phase`) |
| `next_phases` | array de fluxo YAML | Fases às quais o `next_action` se aplica (por exemplo `["4.5"]`) |
| `progress` | bloco | Aninhado `total_phases` / `completed_phases` / `percent` para a barra de progresso do marco |

Todos os quatro campos são **opcionais e aditivos** — arquivos STATE.md sem eles continuam sendo renderizados exatamente como na v1.38.x. Consulte o [esquema STATE.md](reference/state-md.md) para a referência completa de campos, restrições do parser e cenas de renderização.

---

## Ramificação Git

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `git.branching_strategy` | enum | `none` | `none`, `phase` ou `milestone` |
| `git.base_branch` | string | `main` | O branch de integração a partir do qual os branches de fase/marco são criados e nos quais são mesclados de volta. Substitua quando seu repositório usar `master` ou um branch de release |
| `git.create_tag` | boolean | `true` | Cria uma tag git (`v[X.Y]`) na conclusão do marco. Defina como `false` para projetos com seu próprio fluxo de release |
| `git.phase_branch_template` | string | `gsd/phase-{phase}-{slug}` | Template de nome de branch para estratégia de fase |
| `git.milestone_branch_template` | string | `gsd/{milestone}-{slug}` | Template de nome de branch para estratégia de marco |
| `git.quick_branch_template` | string ou null | `null` | Template opcional de nome de branch para tasks `/gsd-quick` |

### Comparação de Estratégias

| Estratégia | Cria Branch | Escopo | Ponto de Merge | Ideal Para |
|----------|---------------|-------|-------------|----------|
| `none` | Nunca | N/A | N/A | Desenvolvimento solo, projetos simples |
| `phase` | No início de `execute-phase` | Uma fase | Usuário faz merge após a fase | Revisão de código por fase, rollback granular |
| `milestone` | No primeiro `execute-phase` | Todas as fases no marco | Em `complete-milestone` | Branches de release, PR por versão |

### Variáveis de Template

| Variável | Disponível Em | Exemplo |
|----------|-------------|---------|
| `{phase}` | `phase_branch_template` | `03` (com zero à esquerda) |
| `{slug}` | Ambos os templates | `user-authentication` (minúsculas, com hífens) |
| `{milestone}` | `milestone_branch_template` | `v1.0` |
| `{num}` / `{quick}` | `quick_branch_template` | `260317-abc` (ID de task rápida) |

Exemplo de ramificação para task rápida:

```json
"git": {
  "quick_branch_template": "gsd/quick-{num}-{slug}"
}
```

### Opções de Merge na Conclusão do Marco

| Opção | Comando Git | Resultado |
|--------|-------------|--------|
| Squash merge (recomendado) | `git merge --squash` | Commit único e limpo por branch |
| Merge com histórico | `git merge --no-ff` | Preserva todos os commits individuais |
| Deletar sem merge | `git branch -D` | Descarta o trabalho do branch |
| Manter branches | (nenhum) | Tratamento manual posterior |

---

## Configurações de Gate

Controla prompts de confirmação durante os fluxos de trabalho.

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `gates.confirm_project` | boolean | `true` | Confirma detalhes do projeto antes de finalizar |
| `gates.confirm_phases` | boolean | `true` | Confirma a divisão de fases |
| `gates.confirm_roadmap` | boolean | `true` | Confirma o roadmap antes de prosseguir |
| `gates.confirm_breakdown` | boolean | `true` | Confirma a divisão de tasks |
| `gates.confirm_plan` | boolean | `true` | Confirma cada plano antes da execução |
| `gates.execute_next_plan` | boolean | `true` | Confirma antes de executar o próximo plano |
| `gates.issues_review` | boolean | `true` | Revisa issues antes de criar planos de correção |
| `gates.confirm_transition` | boolean | `true` | Confirma a transição de fase |

---

## Configurações de Segurança (Safety)

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `safety.always_confirm_destructive` | boolean | `true` | Confirma operações destrutivas (exclusões, sobrescritas) |
| `safety.always_confirm_external_services` | boolean | `true` | Confirma interações com serviços externos |

---

## Configurações de Segurança (Security)

Configurações para o recurso de aplicação de segurança (v1.31). Todas seguem o padrão **ausente = habilitado**. Essas chaves ficam sob `workflow.*` em `.planning/config.json` — correspondendo ao template fornecido e às leituras em tempo de execução em `workflows/plan-phase.md`, `workflows/execute-phase.md`, `workflows/secure-phase.md` e `workflows/verify-work.md`.

Essas chaves ficam sob `workflow.*` — é onde os fluxos de trabalho e o instalador as escrevem e leem. Defini-las no nível superior de `config.json` é silenciosamente ignorado.

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `workflow.security_enforcement` | boolean | `true` | Habilita verificação de segurança ancorada em modelo de ameaças via `/gsd-secure-phase`. Quando `false`, as verificações de segurança são completamente ignoradas |
| `workflow.security_asvs_level` | number (1-3) | `1` | Nível de verificação OWASP ASVS. Nível 1 = oportunístico, Nível 2 = padrão, Nível 3 = abrangente |
| `workflow.security_block_on` | string | `"high"` | Severidade mínima que bloqueia o avanço de fase. Opções: `"high"`, `"medium"`, `"low"` |

---

## Gates de Cobertura de Decisões (`workflow.context_coverage_gate`)

Quando `discuss-phase` escreve decisões de implementação no `<decisions>` de CONTEXT.md,
dois gates garantem que essas decisões sobrevivam à jornada até os planos e o código
enviado (issue #2492).

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `workflow.context_coverage_gate` | boolean | `true` | Controle para ambos os gates de cobertura de decisão. Quando `false`, tanto o gate de tradução na fase de planejamento quanto o gate de validação na fase de verificação são ignorados silenciosamente. |

### O que os gates fazem

**Gate de tradução na fase de planejamento (BLOQUEANTE).** Executado imediatamente após
o gate de cobertura de requisitos existente, antes que os planos sejam commitados. Para cada
decisão rastreável em `<decisions>`, verifica se o id da decisão
(`D-NN`) ou seu texto aparece em pelo menos um `must_haves`,
`truths` ou corpo de plano. Uma ausência expõe a decisão faltante por id e recusa
marcar a fase como planejada.

**Gate de validação na fase de verificação (NÃO BLOQUEANTE).** Executado junto com os
outros passos de verificação. Pesquisa todos os artefatos enviados (PLAN.md, SUMMARY.md, arquivos
modificados, assuntos recentes de commit) para cada decisão rastreável. As ausências são
escritas em VERIFICATION.md como seção de aviso, mas **não** alteram o
status de verificação geral. A assimetria é deliberada — no momento da verificação
o trabalho está concluído, e uma ausência fuzzy de substring não deve reprovar uma fase
caso contrário aprovada.

### Como escrever decisões que os gates aceitam

O template de discuss-phase já produz decisões numeradas com `D-NN`.
O gate fica mais satisfeito quando:

1. Todo plano que implementa uma decisão **cita o id** em algum lugar —
   `must_haves.truths: ["D-12: bit offsets exposed"]` ou uma menção de `D-12:`
   no corpo do plano. A correspondência estrita por id é o caminho mais barato e determinístico.
2. A correspondência suave de frases é um fallback para paráfrases — se um trecho de 6+ palavras
   do texto da decisão aparecer verbatim em um plano/sumário, é aceito.

### Isenções

Uma decisão **não** está sujeita aos gates quando qualquer uma das seguintes
condições se aplica:

- Ela fica sob o título `### Claude's Discretion` dentro de `<decisions>`.
- Ela é marcada como `[informational]`, `[folded]` ou `[deferred]` em seu
  bullet (por exemplo, `- **D-08 [informational]:** Naming style for internal
  helpers`).

Use essas saídas de escape quando uma decisão genuinamente não precisa de
cobertura de plano — discrição de implementação, ideias futuras capturadas para
registro ou itens já adiados para uma fase posterior.

---

## Configurações de Revisão

Configure a seleção de modelo por CLI para `/gsd-review`. Quando definido, substitui o modelo padrão da CLI para aquele revisor.

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `review.models.gemini` | string | (padrão da CLI) | Modelo usado quando o revisor `--gemini` é invocado |
| `review.models.claude` | string | (padrão da CLI) | Modelo usado quando o revisor `--claude` é invocado |
| `review.models.codex` | string | (padrão da CLI) | Modelo usado quando o revisor `--codex` é invocado |
| `review.models.opencode` | string | (padrão da CLI) | Modelo usado quando o revisor `--opencode` é invocado |
| `review.models.qwen` | string | (padrão da CLI) | Modelo usado quando o revisor `--qwen` é invocado |
| `review.models.cursor` | string | (padrão da CLI) | Modelo usado quando o revisor `--cursor` é invocado |
| `review.models.ollama` | string | (padrão do servidor) | Nome do modelo passado ao Ollama quando o revisor `--ollama` é invocado. Se não definido, o primeiro modelo disponível reportado pelo servidor é usado (por exemplo `llama3`). Defina para uma tag específica: `gsd config-set review.models.ollama codellama` |
| `review.models.lm_studio` | string | (padrão do servidor) | Nome do modelo passado ao LM Studio quando o revisor `--lm-studio` é invocado. Se não definido, o primeiro modelo disponível reportado pelo servidor é usado. |
| `review.models.llama_cpp` | string | (padrão do servidor) | Nome do modelo passado ao llama.cpp quando o revisor `--llama-cpp` é invocado. Se não definido, o primeiro modelo reportado por `/v1/models` é usado. |
| `review.default_reviewers` | string[] \| null | (todos os revisores detectados) | Subconjunto de revisores padrão para `/gsd-review` sem flags. Exemplo: `["gemini","codex"]`. Flags explícitas e `--all` substituem esta configuração. |
| `review.max_prompt_tokens` | number\|null | null | Máximo padrão de tokens estimados para o prompt de revisão montado. Quando definido, o prompt é cortado deterministicamente antes de ser enviado a cada revisor. Substituições por revisor via `review.max_prompt_tokens_per_reviewer` têm precedência. null = sem corte (comportamento atual). |
| `review.max_prompt_tokens_per_reviewer` | object | {} | Substituições de orçamento de tokens por revisor. As chaves são slugs de revisor (ollama, llama_cpp, lm_studio, gemini, claude, codex, opencode, qwen, cursor). Os valores substituem `review.max_prompt_tokens` para aquele revisor. Recomendado para servidores de modelos locais. |
| `review.ollama_host` | string | `http://localhost:11434` | URL base do servidor Ollama. Substitua quando executar o Ollama em uma porta não padrão ou host remoto: `gsd config-set review.ollama_host http://192.168.1.10:11434` |
| `review.lm_studio_host` | string | `http://localhost:1234` | URL base do servidor local LM Studio. Substitua quando usar uma porta não padrão. |
| `review.llama_cpp_host` | string | `http://localhost:8080` | URL base do servidor llama.cpp (`llama-server`). Substitua quando usar uma porta não padrão. |

### Orçamentos de prompt para revisores com contexto pequeno

Servidores de modelos locais (Ollama, llama.cpp, LM Studio) geralmente aceitam muito menos tokens que as APIs em nuvem. Definir `review.max_prompt_tokens_per_reviewer` (ou o fallback global `review.max_prompt_tokens`) aciona o corte determinístico do prompt antes de enviá-lo ao revisor: CONTEXT é descartado primeiro, depois RESEARCH, depois REQUIREMENTS; PROJECT.md é reduzido ao cabeçalho das primeiras 40 linhas; PLANs são truncados pela cauda proporcionalmente — instruções e roadmap são sempre preservados. Quando um revisor é cortado, uma nota de divulgação é injetada no topo do prompt e os metadados de corte (orçamento, seções omitidas, porcentagem de truncamento) são registrados no frontmatter de REVIEWS.md em `trimmed_reviewers`. Se até mesmo o conjunto mínimo de revisão (instruções + roadmap + stubs de plano) exceder o orçamento, o revisor é ignorado com um aviso em vez de enviar um prompt truncado que produziria feedback enganoso.

### Exemplo

```json
{
  "review": {
    "models": {
      "gemini": "gemini-2.5-pro",
      "qwen": "qwen-max"
    }
  }
}
```

Usa o padrão configurado de cada CLI quando uma chave está ausente. Adicionado na v1.35.0 (#1849).

---

## Flags de Passagem do Manager

Configure flags por etapa que `/gsd-manager` acrescenta a cada comando despachado. Isso permite personalizar como o manager executa as etapas de discuss, plan e execute sem entrada manual de flags.

| Configuração | Tipo | Padrão | Descrição |
|---------|------|---------|-------------|
| `manager.flags.discuss` | string | (nenhum) | Flags acrescidas a comandos de discuss-phase (por exemplo, `"--auto"`) |
| `manager.flags.plan` | string | (nenhum) | Flags acrescidas a comandos de plan-phase (por exemplo, `"--skip-research"`) |
| `manager.flags.execute` | string | (nenhum) | Flags acrescidas a comandos de execute-phase (por exemplo, `"--cross-ai"`) |

**Exemplo:**

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

Tokens de flag inválidos são sanitizados e registrados como avisos. Apenas flags GSD reconhecidas são repassadas.

---

## Perfis de Modelo

### Definições de Perfil

| Agente | `quality` | `balanced` | `budget` | `adaptive` | `inherit` |
|-------|-----------|------------|----------|------------|-----------|
| gsd-planner | Opus | Opus | Sonnet | Opus | Inherit |
| gsd-roadmapper | Opus | Sonnet | Sonnet | Opus | Inherit |
| gsd-executor | Opus | Sonnet | Sonnet | Sonnet | Inherit |
| gsd-phase-researcher | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-project-researcher | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-research-synthesizer | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-debugger | Opus | Sonnet | Sonnet | Opus | Inherit |
| gsd-codebase-mapper | Sonnet | Haiku | Haiku | Haiku | Inherit |
| gsd-verifier | Sonnet | Sonnet | Haiku | Sonnet | Inherit |
| gsd-plan-checker | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-integration-checker | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-nyquist-auditor | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-pattern-mapper | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-ui-researcher | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-ui-checker | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-ui-auditor | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-doc-writer | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-doc-verifier | Sonnet | Sonnet | Haiku | Haiku | Inherit |

> **Todos os 33 agentes incluídos possuem atribuições explícitas de nível por perfil** no catálogo (`sdk/shared/model-catalog.json`). A tabela acima mostra um subconjunto representativo dos agentes mais usados. Para agentes não listados aqui, `model_overrides` aceita qualquer nome de agente incluído. Os dados autoritativos de perfil são derivados de `sdk/shared/model-catalog.json` via `gsd-core/bin/lib/model-catalog.cjs` e `sdk/src/model-catalog.ts`.

### Substituições por Agente

Substitua agentes específicos sem alterar o perfil inteiro:

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "gsd-executor": "opus",
    "gsd-planner": "haiku"
  }
}
```

Valores de substituição válidos: `opus`, `sonnet`, `haiku`, `inherit` ou qualquer ID de modelo totalmente qualificado (por exemplo, `"openai/o3"`, `"google/gemini-2.5-pro"`).

`model_overrides` pode ser definido em `.planning/config.json` (por projeto)
ou `~/.gsd/defaults.json` (global). Entradas por projeto ganham em conflito e
entradas globais sem conflito são preservadas, então você pode ajustar o modelo de um único
agente em um repositório sem redefinir os padrões globais. Isso se aplica
uniformemente em Claude Code, Codex, OpenCode, Kilo e outros
runtimes suportados. No Codex e OpenCode, o modelo resolvido é incorporado
na configuração estática de cada agente no momento da instalação — `spawn_agent` e
a interface `task` do OpenCode não aceitam um parâmetro `model` inline, então
executar `gsd install <runtime>` após editar `model_overrides` é obrigatório
para que a alteração entre em vigor. Consulte a issue #2256.

### Modelos Por Tipo de Fase (`models`) — adicionado na v1.41

> Expresse ajuste no nível de **fase** (planning, research, execution, verification) sem precisar conhecer a taxonomia de agentes. Adicionado em [#3023](https://github.com/open-gsd/gsd-core/pull/3030).

`model_overrides` é por **agente** (preciso mas verboso; você precisa saber que `gsd-codebase-mapper` é pesquisa e `gsd-doc-writer` é execução). O bloco `models` permite dizer "Opus para planejamento e execução, Sonnet para o restante" em duas linhas:

```json
{
  "model_profile": "balanced",
  "models": {
    "planning": "opus",
    "discuss": "opus",
    "research": "sonnet",
    "execution": "opus",
    "verification": "sonnet",
    "completion": "sonnet"
  },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

#### Mapeamento tipo de fase → agente

| Tipo de fase | Agentes |
|---|---|
| `planning` | `gsd-planner`, `gsd-roadmapper`, `gsd-pattern-mapper` |
| `discuss` | `gsd-assumptions-analyzer` |
| `research` | `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-research-synthesizer`, `gsd-codebase-mapper`, `gsd-ui-researcher` |
| `execution` | `gsd-executor`, `gsd-debugger`, `gsd-doc-writer` |
| `verification` | `gsd-verifier`, `gsd-plan-checker`, `gsd-integration-checker`, `gsd-nyquist-auditor`, `gsd-ui-checker`, `gsd-ui-auditor`, `gsd-doc-verifier`, `gsd-code-reviewer` |
| `completion` | (reservado — sem subagente atualmente) |

`discuss` e `completion` são aceitos pelo esquema para compatibilidade futura; defini-los hoje é um no-op até que um subagente seja mapeado para eles.

#### Precedência de resolução (mais alta → mais baixa)

```text
1. model_overrides[<agent>]              ← por agente; IDs completos; exceção direcionada
2. dynamic_routing.tier_models[<tier>]   ← quando habilitado (consulte §Dynamic Routing)
3. models[<phase_type>]                  ← nível de fase grosseiro (esta seção)
4. model_profile (coluna por agente)     ← estratégia global de nível
5. Padrão de runtime                     ← quando nada mais se aplica
```

As cinco camadas compõem de cima para baixo: `model_profile` é o nível base, `models[<phase_type>]` substitui no nível de fase, `dynamic_routing` (quando habilitado) escala por tentativa em falha soft, `model_overrides[<agent>]` cria exceções por agente no topo, e o padrão de runtime se aplica quando nada mais se aplica. No exemplo acima, todos os cinco agentes de pesquisa resolvem para `sonnet` *exceto* `gsd-codebase-mapper`, que a substituição por agente fixa em `haiku`. `dynamic_routing` está desabilitado por padrão — quando desativado (`enabled: false` ou bloco omitido), o comportamento desta seção não se altera em relação ao atual.

#### Valores aceitos

`models.<phase_type>` aceita apenas aliases de nível:

| Valor | Efeito |
|---|---|
| `"opus"` / `"sonnet"` / `"haiku"` | Nível padrão — a resolução de runtime mapeia para o modelo do runtime ativo para aquele nível |
| `"inherit"` | Agentes nesta fase seguem o modelo da sessão (mesma semântica que `model_profile: "inherit"`) |

Se você precisar de um ID de modelo totalmente qualificado (`"openai/gpt-5"`, `"google/gemini-2.5-pro"`), use `model_overrides` por agente. `models.*` é intencionalmente apenas de nível para que o mapeamento com reconhecimento de runtime permaneça correto nas instalações Codex / OpenCode / Gemini CLI.

#### Quando usar qual

| Você quer | Use |
|---|---|
| Uma estratégia global de nível ("balanced em tudo") | `model_profile` |
| Ajuste grosseiro por fase ("Opus para planejamento") | `models.<phase_type>` |
| Precisão por agente ("forçar haiku no mapeador de base de código") | `model_overrides[<agent>]` |
| ID de modelo completo para um agente específico | `model_overrides[<agent>]: "openai/gpt-5"` |

Combine livremente — a regra de precedência acima resolve qualquer sobreposição deterministicamente.

#### Validação

`config-set` rejeita tipos de fase desconhecidos:

```bash
$ gsd config-set models.deployment opus
Error: 'models.deployment' is not a valid config key

# Válido:
$ gsd config-set models.research sonnet
```

Edições diretas em `.planning/config.json` são mais permissivas — o resolvedor simplesmente ignora valores que não reconhece e cai para o nível de perfil — então um erro de digitação não quebra silenciosamente a resolução de nível.

### Roteamento Dinâmico com Escalada por Nível em Falha (`dynamic_routing`) — adicionado na v1.41

> Comece barato, escale apenas quando o agente falhar no gate. Adicionado em [#3024](https://github.com/open-gsd/gsd-core/pull/3031).

`dynamic_routing` permite pagar pelo nível barato por padrão e escalar para o nível mais caro apenas quando o orquestrador detecta uma falha soft (verificação inconclusiva, FLAG no plan-check, etc.).

```json
{
  "dynamic_routing": {
    "enabled": true,
    "tier_models": {
      "light":    "haiku",
      "standard": "sonnet",
      "heavy":    "opus"
    },
    "escalate_on_failure": true,
    "max_escalations": 1
  }
}
```

#### Níveis padrão dos agentes

Cada agente em `MODEL_PROFILES` declara um de três níveis padrão. O resolvedor escolhe `tier_models[default_tier]` para a primeira tentativa.

| Nível | Agentes | Caso de uso |
|---|---|---|
| `light` | gsd-codebase-mapper, gsd-doc-classifier, gsd-doc-verifier, gsd-integration-checker, gsd-intel-updater, gsd-nyquist-auditor, gsd-pattern-mapper, gsd-plan-checker, gsd-research-synthesizer, gsd-ui-auditor, gsd-ui-checker | Barato/rápido — mapeadores puros, scanners, auditorias de baixo risco |
| `standard` | gsd-advisor-researcher, gsd-ai-researcher, gsd-code-fixer, gsd-code-reviewer, gsd-doc-synthesizer, gsd-doc-writer, gsd-domain-researcher, gsd-eval-auditor, gsd-executor, gsd-phase-researcher, gsd-project-researcher, gsd-ui-researcher, gsd-verifier | Motor padrão — pesquisa, escrita, verificação primária |
| `heavy` | gsd-assumptions-analyzer, gsd-debug-session-manager, gsd-debugger, gsd-eval-planner, gsd-framework-selector, gsd-planner, gsd-roadmapper, gsd-security-auditor, gsd-user-profiler | Raciocínio profundo — já no topo, não pode escalar mais |

#### Fluxo de escalada

```text
1. Orquestrador gera agente → resolvedor retorna tier_models[default_tier]
2. Falha soft?
   ├─ não → ✓ concluído (caminho barato)
   └─ sim → orquestrador re-gera na tentativa+1
            → resolvedor retorna tier_models[next_tier_up]
            → limita em max_escalations
3. Falha hard (exceção/crash) → ignora escalada, expõe imediatamente
```

Se `dynamic_routing.escalate_on_failure: false`, falhas soft **não** avançam o nível — cada respawn continua usando `tier_models[default_tier]` independentemente do contador de tentativas. A chave kill-switch substitui o ramo de falha soft acima.

`light → standard → heavy → heavy` (heavy permanece em heavy; não pode ir mais longe).

#### Precedência de resolução (mais alta → mais baixa)

1. **`model_overrides[<agent>]`** — IDs completos aceitos; exceção direcionada
2. **`dynamic_routing.tier_models[<tier>]`** (quando `enabled: true`)
3. **`models[<phase_type>]`** — fase grosseira por nível (#3023)
4. **`model_profile`** — coluna por agente do perfil ativo
5. **Padrão de runtime**

O bloco `dynamic_routing` está **desabilitado por padrão** — `enabled: false` (ou omitir o bloco) preserva exatamente a resolução estática atual.

#### Configurações

| Chave | Tipo | Padrão | Descrição |
|---|---|---|---|
| `dynamic_routing.enabled` | boolean | `false` | Chave mestra. Quando `true`, o resolvedor de roteamento dinâmico é usado para seleção de nível. |
| `dynamic_routing.tier_models.light` | enum | (nenhum) | Alias de nível para o nível light. Tipicamente `haiku`. |
| `dynamic_routing.tier_models.standard` | enum | (nenhum) | Alias de nível para standard. Tipicamente `sonnet`. |
| `dynamic_routing.tier_models.heavy` | enum | (nenhum) | Alias de nível para heavy. Tipicamente `opus`. |
| `dynamic_routing.escalate_on_failure` | boolean | `true` | Quando false, a escalada é desabilitada (cada tentativa usa o nível padrão). |
| `dynamic_routing.max_escalations` | integer | `1` | Limite máximo de tentativas por invocação de agente. Previne loops descontrolados. |

#### Quando usar qual

| Você quer | Use |
|---|---|
| Uma estratégia de nível para todos os agentes | `model_profile` |
| Ajuste grosseiro por fase | `models.<phase_type>` |
| Precisão por agente (IDs completos) | `model_overrides` |
| **Barato por padrão, escalar apenas em falha** | **`dynamic_routing`** |

`dynamic_routing` é estruturalmente uma *alavanca de custo*: você paga tarifas Opus apenas para os casos difíceis que justificam o Opus. Combine com `model_overrides` para exceções por agente (a substituição sempre vence).

---

### Controle de Esforço (`effort`) — adicionado na v1.42

> Controle de esforço unificado entre provedores. Adicionado em [#443](https://github.com/open-gsd/gsd-core/issues/443).

Controle o esforço de raciocínio das invocações de agente com uma única configuração. A escala universal é:

```
minimal < low < medium < high < xhigh < max
```

O esforço é renderizado por runtime: `output_config.effort` para Claude (frontmatter `effort` de subagente do Claude Code / env `CLAUDE_CODE_EFFORT_LEVEL`), `model_reasoning_effort` para Codex (Responses API `reasoning.effort`).

**Limitação entre provedores:** `max` é exclusivo da Anthropic — limita a `xhigh` no Codex. `minimal` é exclusivo do Codex — limita a `low` no Claude.

O hint `reasoning_effort` por nível do catálogo de modelos é um campo legado mantido para referência; o esforço agora é controlado por configuração.

**Precedência (mais alta → mais baixa):**
1. Substituição de invocação (por exemplo, flag `--effort` em `resolve-execution`)
2. `effort.agent_overrides[<agent-id>]`
3. `effort.routing_tier_defaults[<light|standard|heavy>]`
4. `effort.default`
5. `"high"` (padrão universal do Claude)

```json
{
  "effort": {
    "default": "high",
    "routing_tier_defaults": {
      "light":    "low",
      "standard": "high",
      "heavy":    "xhigh"
    },
    "agent_overrides": {
      "gsd-planner": "max"
    }
  }
}
```

#### Configurações

| Chave | Tipo | Padrão | Descrição |
|---|---|---|---|
| `effort.default` | enum | `"high"` | Nível de esforço global fallback. Aplica-se quando nenhuma substituição de nível ou agente corresponde. |
| `effort.routing_tier_defaults.light` | enum | `"low"` | Esforço para agentes de nível light (mapeadores/scanners rápidos). |
| `effort.routing_tier_defaults.standard` | enum | `"high"` | Esforço para agentes de nível standard (agentes motor). |
| `effort.routing_tier_defaults.heavy` | enum | `"xhigh"` | Esforço para agentes de nível heavy (raciocínio profundo). |
| `effort.agent_overrides.<agent-id>` | enum | (nenhum) | Substituição de esforço por agente. Supera os padrões de nível. |

Valores de esforço válidos: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

---

### Modo Rápido (`fast_mode`) — adicionado na v1.42

> Controle de propagação de fast_mode por agente. Adicionado em [#443](https://github.com/open-gsd/gsd-core/issues/443).

Controla se fast_mode é propagado para invocações de agente. Aceita apenas booleanos reais — string `"true"` é rejeitada.

**Nota:** `fast_mode` só é propagável via runtimes de API (velocidade `api`:"fast"). O Claude Code não possui mecanismo de fast-mode por subagente — `/fast` é apenas no nível de sessão, então emitir uma chave de frontmatter `fast_mode` em um subagente Claude é um no-op silencioso. `fast_mode_supported` na saída de `resolve-execution` informa se o runtime configurado suporta propagação de fast_mode por agente.

**Precedência (mais alta → mais baixa):**
1. Substituição de invocação (por exemplo, flag `--fast-mode` em `resolve-execution`)
2. `fast_mode.agent_overrides[<agent-id>]` (boolean)
3. `fast_mode.routing_tier_defaults[<light|standard|heavy>]` (boolean)
4. `fast_mode.enabled` (boolean)
5. `false`

```json
{
  "fast_mode": {
    "enabled": false,
    "routing_tier_defaults": {
      "light":    true,
      "standard": false,
      "heavy":    false
    },
    "agent_overrides": {}
  }
}
```

#### Configurações

| Chave | Tipo | Padrão | Descrição |
|---|---|---|---|
| `fast_mode.enabled` | boolean | `false` | Flag global fast_mode. Honorada apenas quando nenhuma substituição de nível/agente corresponde. |
| `fast_mode.routing_tier_defaults.light` | boolean | `true` | Modo rápido para agentes de nível light. |
| `fast_mode.routing_tier_defaults.standard` | boolean | `false` | Modo rápido para agentes de nível standard. |
| `fast_mode.routing_tier_defaults.heavy` | boolean | `false` | Modo rápido para agentes de nível heavy. |
| `fast_mode.agent_overrides.<agent-id>` | boolean | (nenhum) | Substituição de fast_mode por agente. |

---

### Consulta de Execução (`resolve-execution`)

Use `node gsd-tools.cjs resolve-execution <agent-type> [--effort <level>] [--fast-mode <true|false>] [--attempt <n>]` para obter o contexto completo de execução resolvido para um agente:

```json
{
  "model":             "opus",
  "profile":           "balanced",
  "effort":            "xhigh",
  "effort_rendered":   "xhigh",
  "effort_param":      "output_config.effort",
  "effort_propagation": "frontmatter",
  "fast_mode":         false,
  "fast_mode_supported": false
}
```

`effort_param` informa qual parâmetro de runtime definir. `fast_mode_supported` informa se o runtime configurado suporta propagação de fast_mode por agente.

---

### Runtimes Não-Claude (Codex, OpenCode, Gemini CLI, Kilo)

> **Versão mínima suportada do Codex CLI: `0.130.0`** (issue [#3562](https://github.com/open-gsd/gsd-core/issues/3562)).
>
> O [Codex CLI 0.130.0](https://github.com/openai/codex/releases/tag/rust-v0.130.0) (lançado em 2026-05-08) removeu a descoberta de extra-skills-roots via [openai/codex#21485](https://github.com/openai/codex/pull/21485). A partir desta versão, o Codex CLI só verifica `~/.codex/skills/<name>/SKILL.md`, `<project>/.codex/skills/` e raízes de plugin registradas para habilidades invocáveis. O GSD instala a superfície `$gsd-*` como `~/.codex/skills/gsd-<name>/SKILL.md` para que os comandos resolvam após uma reinicialização do Codex. Versões anteriores do Codex CLI podem mostrar uma listagem duplicada (a varredura legada de extra-roots mais as cópias da raiz do usuário) — reinicie o Codex e atualize para ≥ 0.130.0 ou aceite as duplicatas até fazê-lo.

Quando o GSD é instalado para um runtime não-Claude, o instalador automaticamente define `resolve_model_ids: "omit"` em `~/.gsd/defaults.json`. Isso faz o GSD retornar um parâmetro de modelo vazio para todos os agentes, para que cada agente use o modelo com que o runtime está configurado. Nenhuma configuração adicional é necessária para o caso padrão.

Se você quiser que agentes diferentes usem modelos diferentes, use `model_overrides` com IDs de modelo totalmente qualificados que seu runtime reconhece:

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner": "o3",
    "gsd-executor": "o4-mini",
    "gsd-debugger": "o3",
    "gsd-codebase-mapper": "o4-mini"
  }
}
```

A intenção é a mesma que os níveis de perfil do Claude -- use um modelo mais forte para planejamento e depuração (onde a qualidade de raciocínio mais importa) e um modelo mais barato para execução e mapeamento (onde o plano já contém o raciocínio).

**Quando usar qual abordagem:**

| Cenário | Configuração | Efeito |
|----------|---------|--------|
| Runtime não-Claude, modelo único | `resolve_model_ids: "omit"` (padrão do instalador) | Todos os agentes usam o modelo padrão do runtime |
| Runtime não-Claude, modelos em nível | `resolve_model_ids: "omit"` + `model_overrides` | Agentes nomeados usam modelos específicos, outros usam o padrão do runtime |
| Claude Code com OpenRouter/provedor local | `model_profile: "inherit"` | Todos os agentes seguem o modelo da sessão |
| Claude Code com OpenRouter, em nível | `model_profile: "inherit"` + `model_overrides` | Agentes nomeados usam modelos específicos, outros herdam |

**Valores de `resolve_model_ids`:**

| Valor | Comportamento | Use Quando |
|-------|----------|----------|
| `false` (padrão) | Retorna aliases Claude (`opus`, `sonnet`, `haiku`) | Claude Code com API Anthropic nativa |
| `true` | Mapeia aliases para IDs completos de modelo Claude (`claude-opus-4-8`) | Claude Code com API que requer IDs completos |
| `"omit"` | Retorna string vazia (runtime escolhe seu padrão) | Runtimes não-Claude (Codex, OpenCode, Gemini CLI, Kilo) |

### Perfis com Reconhecimento de Runtime (#2517)

Quando `runtime` é definido, os níveis de perfil (`opus`/`sonnet`/`haiku`) resolvem para IDs de modelo nativos do runtime em vez de aliases Claude. Isso permite que um único `.planning/config.json` compartilhado funcione perfeitamente entre Claude e Codex.

A saída JSON de `resolve-model` inclui `reasoning_effort` quando o nível de runtime resolvido para o agente (após substituições de tipo de fase) define um `reasoning_effort`. Adaptadores de runtime podem passar esse valor para chamadas de lançamento de agente filho que o suportam; runtimes sem suporte explícito o omitem.

**Mapas de nível integrados:**

| Runtime | `opus` | `sonnet` | `haiku` | reasoning_effort |
|---------|--------|----------|---------|------------------|
| `claude` | `claude-opus-4-8` | `claude-sonnet-5` | `claude-haiku-4-5` | (não usado) |
| `codex` | `gpt-5.6-sol` | `gpt-5.6-terra` | `gpt-5.6-luna` | `xhigh` / `medium` / `medium` |
| `gemini` | `gemini-3-pro` | `gemini-3-flash` | `gemini-2.5-flash-lite` | (não usado) |
| `qwen` | `qwen3-max-2026-01-23` | `qwen3-coder-plus` | `qwen3-coder-next` | (não usado) |
| `opencode` | `anthropic/claude-opus-4-8` | `anthropic/claude-sonnet-5` | `anthropic/claude-haiku-4-5` | (não usado) |
| `copilot` | `claude-opus-4-8` | `claude-sonnet-5` | `claude-haiku-4-5` | (não usado) |
| `hermes` | `anthropic/claude-opus-4-8` | `anthropic/claude-sonnet-5` | `anthropic/claude-haiku-4-5` | (não usado) |
| Grupo B (`kilo`, `cline`, `cursor`, `windsurf`, `augment`, `trae`, `codebuddy`, `antigravity`) | (sem padrão integrado — seu runtime trata da seleção de modelo) | | | |

**Exemplo Codex** — uma configuração, modelos em nível, sem bloco grande de `model_overrides`:

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

Isso resolve `gsd-planner` → `gpt-5.6-sol` (xhigh), `gsd-executor` → `gpt-5.6-terra` (medium), `gsd-codebase-mapper` → `gpt-5.6-luna` (medium). O instalador do Codex incorpora `model = "..."` e `model_reasoning_effort = "..."` em cada TOML de agente gerado.

**Exemplo Claude** — opt-in explícito resolve para IDs Claude completos (sem necessidade de `resolve_model_ids: true`):

```json
{
  "runtime": "claude",
  "model_profile": "quality"
}
```

**Substituições por runtime** — substitua um ou mais padrões de nível:

```json
{
  "runtime": "codex",
  "model_profile": "quality",
  "model_profile_overrides": {
    "codex": {
      "opus": "gpt-5-pro",
      "haiku": { "model": "gpt-5-nano", "reasoning_effort": "low" }
    }
  }
}
```

**Precedência (mais alta para mais baixa):**

1. `model_overrides[<agent>]` — ID explícito por agente sempre vence.
2. **Resolução de nível com reconhecimento de runtime** (esta seção) — quando `runtime` é definido e o perfil não é `inherit`.
3. `resolve_model_ids: "omit"` — retorna string vazia quando nenhum `runtime` é definido.
4. Padrão nativo Claude — nível de `model_profile` como alias (padrão atual).
5. `inherit` — propaga o literal `inherit` para semântica de `Task(model="inherit")`.

**Compatibilidade retroativa.** Configurações sem `runtime` definido não veem nenhuma mudança de comportamento — cada configuração existente continua funcionando identicamente. Instalações Codex que auto-definem `resolve_model_ids: "omit"` continuam omitindo o campo de modelo a menos que o usuário opte por definir `runtime: "codex"`.

**Runtimes desconhecidos.** Se `runtime` for definido para um valor sem mapa de nível integrado e sem `model_profile_overrides[<runtime>]`, o GSD cai de volta para o padrão seguro de alias Claude em vez de emitir um ID de modelo que o runtime não pode aceitar. Para suportar um novo runtime, popule `model_profile_overrides.<runtime>.{opus,sonnet,haiku}` com IDs válidos.

### Filosofia de Perfil

| Perfil | Filosofia | Quando Usar |
|---------|-----------|-------------|
| `quality` | Opus para toda tomada de decisão, Sonnet para verificação | Cota disponível, trabalho arquitetural crítico |
| `balanced` | Opus apenas para planejamento, Sonnet para todo o restante | Desenvolvimento normal (padrão) |
| `budget` | Sonnet para escrita de código, Haiku para pesquisa/verificação | Trabalho de alto volume, fases menos críticas |
| `inherit` | Todos os agentes usam o modelo de sessão atual | Alternância dinâmica de modelo, **provedores não-Anthropic** (OpenRouter, modelos locais) |

---

## Predefinições de Política de Modelo (`model_policy`) — adicionado na v1.42

> **[#49](https://github.com/open-gsd/gsd-core/issues/49)** — superfície de configuração de política de modelo neutra em relação ao provedor. Resolve antes do legado `model_profile_overrides`.

`model_policy` fornece uma maneira mais simples e neutra em relação ao provedor de configurar níveis de modelo entre runtimes. É a superfície preferida para runtimes não-Anthropic onde `model_profile_overrides` exigiria conhecer manualmente os IDs de modelo corretos. Configure via `/gsd:settings` → Seção 8 (Model Policy).

### Predefinição de provedor conhecido

Escolha um provedor e nível de orçamento via o fluxo de configurações; o GSD escreve os IDs de modelo canônicos para aquela combinação de provedor/orçamento:

```json
{
  "runtime": "codex",
  "model_policy": {
    "provider": "openai",
    "budget": "medium",
    "high":   "gpt-5.6-sol",
    "medium": "gpt-5.6-terra",
    "low":    "gpt-5.6-luna"
  }
}
```

Provedores conhecidos: `openai`, `anthropic`, `anthropic-fable`, `google`, `qwen`. Níveis de orçamento: `high`, `medium`, `low`. Use `anthropic` para manter a predefinição Claude baseada em Opus 4.8, ou `anthropic-fable` para optar pelo Claude Fable 5 no roteamento de alto orçamento.

Para controle avançado por runtime, `runtime_tiers` aceita entradas explícitas usando os nomes internos de nível de perfil (`opus`, `sonnet`, `haiku`):

```json
{
  "runtime": "codex",
  "model_policy": {
    "provider": "openai",
    "runtime_tiers": {
      "codex": {
        "opus":   { "model": "gpt-5.6-sol",        "reasoning_effort": "high" },
        "sonnet": { "model": "gpt-5.6-terra",     "reasoning_effort": "medium" },
        "haiku":  { "model": "gpt-5.6-luna",      "reasoning_effort": "low" }
      }
    }
  }
}
```

### Provedor genérico (saída de escape)

Use `provider: "generic"` (ou `"custom"`) para OpenRouter, LiteLLM, gateways locais ou qualquer runtime onde você fornece IDs de modelo exatos. O GSD trata IDs de modelo como strings opacas — sem inferência de prefixo, sem padrões específicos do provedor:

```json
{
  "runtime": "opencode",
  "model_policy": {
    "provider": "generic",
    "high":   "openrouter/anthropic/claude-opus-4-5",
    "medium": "openrouter/anthropic/claude-sonnet-4-5",
    "low":    "openrouter/anthropic/claude-haiku-4-5"
  }
}
```

### Limitação de esforço de raciocínio

`reasoning_effort` dentro de uma entrada `runtime_tiers` é encaminhado apenas para runtimes que declaram suporte para ele (atualmente: `codex`). Qualquer runtime fora da lista de permissões recebe a entrada de nível sem o campo `reasoning_effort` — ele é silenciosamente removido, nunca vazado.

### Precedência

A resolução de `model_policy` fica acima de `model_profile_overrides` no resolvedor:

1. `model_overrides[<agent>]` — ID explícito por agente (mais alto)
2. `model_policy.runtime_tiers[<runtime>][<tier>]` — entrada explícita de runtime/nível
3. Chaves flat `high`/`medium`/`low` de `model_policy` — para provedor `generic`/`custom`
4. `model_profile_overrides[<runtime>][<tier>]` — substituição legada por runtime
5. Padrão do catálogo de runtime integrado
6. Alias de nível de `model_profile`

**Compatibilidade retroativa.** Configurações sem `model_policy` não são afetadas. Blocos `model_profile_overrides` existentes continuam funcionando exatamente como antes.

---

## Variáveis de Ambiente

| Variável | Finalidade |
|----------|---------|
| `CLAUDE_CONFIG_DIR` | Substitui o diretório de configuração padrão (`~/.claude/`) |
| `GEMINI_API_KEY` | Detectada pelo monitor de contexto para alternar o nome do evento hook |
| `GSD_AUDIT` | Defina como `1` para habilitar o arquivo de auditoria de despacho (`.planning/.gsd-trace.jsonl`) |
| `GSD_AUDIT_ARGS` | Defina como `1` para incluir args de comando nos eventos de auditoria/erro (omitidos por padrão) |
| `GSD_PROJECT` | Substitui a raiz do projeto para suporte a workspace multi-projeto (v1.32) |
| `GSD_SKIP_SCHEMA_CHECK` | Ignora a detecção de deriva de esquema durante a fase de execução (v1.31) |
| `WSL_DISTRO_NAME` | Detectado pelo instalador para tratamento de caminhos WSL |

---

## Padrões Globais

Salve configurações como padrões globais para projetos futuros:

**Localização:** `~/.gsd/defaults.json`

Quando `/gsd-new-project` cria um novo `config.json`, ele lê os padrões globais e os mescla como configuração inicial. Configurações por projeto sempre substituem os globais.

---

## Observabilidade

O Hub de Roteamento de Comandos emite um `DispatchEvent` estruturado após cada despacho. O comportamento padrão é **silencioso em caso de sucesso** e **uma linha JSON estruturada para stderr em caso de erro**.

### Formato de erro no stderr

Quando um despacho falha, uma linha JSON é emitida para stderr:

```json
{ "kind": "HandlerFailure", "traceId": "...", "command": "plan", "timestamp": "...", "message": "..." }
```

O campo `kind` corresponde a uma das variantes de erro do Hub: `UnknownCommand`, `InvalidArgs`, `HandlerRefusal` ou `HandlerFailure`. Args são omitidos por padrão (privacidade); consulte `GSD_AUDIT_ARGS` abaixo.

### Trilha de auditoria (opt-in)

Habilite o arquivo de auditoria somente-acréscimo para registrar cada despacho (sucesso e erro):

**Via variável de ambiente:**
```bash
GSD_AUDIT=1 gsd plan
```

**Via configuração (`config.audit.enabled`):**
```json
{
  "audit": {
    "enabled": true
  }
}
```

**Localização do arquivo de auditoria:** `.planning/.gsd-trace.jsonl` (gitignored)

Cada linha é um objeto JSON completo de `DispatchEvent` contendo tanto `traceId` (um UUID v4 único por despacho) quanto `parentTraceId` (presente quando um chamador passa `req.parentTraceId` para `Hub.dispatch`). Um futuro init-composer (Fase 2) irá conectar `parentTraceId` automaticamente para que todos os despachos filhos de uma única invocação de nível superior compartilhem um pai comum; até então, despachos folha emitem `parentTraceId: undefined`. Você pode correlacionar eventos filhos a um pai filtrando o arquivo de auditoria em `parentTraceId === <rootTraceId>`. O arquivo é somente-acréscimo e nunca truncado; rotacione ou remova-o manualmente quando desejado. `parentTraceId` deve ser um UUID v4 canônico (RFC 4122, formato `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`); valores que não correspondem a este formato são silenciosamente descartados do evento emitido e não aparecerão na saída de auditoria.

### Redação de args

Por padrão, os args de comando são **omitidos** de todos os eventos emitidos (tanto erros de stderr quanto o arquivo de auditoria). Para incluir args verbatim:

```bash
GSD_AUDIT_ARGS=1 GSD_AUDIT=1 gsd plan --tdd
```

`GSD_AUDIT_ARGS` aplica-se simultaneamente tanto à linha de erro do stderr quanto ao arquivo de auditoria.

---

## Relacionados

- [Comandos](COMMANDS.md)
- [Configurar perfis de modelo](how-to/configure-model-profiles.md)
- [Esquema STATE.md](reference/state-md.md)
- [Índice da documentação](README.md)
