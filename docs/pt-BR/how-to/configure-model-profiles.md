# Como configurar perfis de modelo

Escolha a estratégia de nível de modelo adequada para o seu projeto e ajuste agentes individuais ou tipos de fase inteiros sem precisar escrever um bloco de substituição extenso. Este guia começa pelo controle mais simples e avança até o roteamento dinâmico.

---

## Os quatro perfis (mais `adaptive` e `inherit`)

Defina `model_profile` em `.planning/config.json` ou via `/gsd-config --profile <name>`:

| Perfil | Planejador | Executor | Pesquisadores | Verificador | Usar quando |
|--------|-----------|----------|---------------|-------------|-------------|
| `quality` | Opus | Opus | Opus | Sonnet | Trabalho de qualidade para produção onde o custo é secundário |
| `balanced` | Opus | Sonnet | Sonnet | Sonnet | Desenvolvimento normal — o padrão |
| `budget` | Sonnet | Sonnet | Haiku | Haiku | Prototipagem rápida, contextos com restrições de custo |
| `adaptive` | Opus | Sonnet | Sonnet | Sonnet | Resolve da mesma forma que os outros níveis em perfis cientes de runtime; use ao alternar entre runtimes com frequência |
| `inherit` | (modelo da sessão) | (modelo da sessão) | (modelo da sessão) | (modelo da sessão) | Provedores não-Anthropic (OpenRouter, modelos locais) — todos os agentes seguem o modelo atual da sessão |

A tabela acima mostra um subconjunto representativo. Todos os 33 agentes incluídos possuem atribuições de nível explícitas por perfil em `gsd-core/bin/shared/model-catalog.json`. Para a tabela completa, consulte [Perfis de Modelo](../CONFIGURATION.md#model-profiles) na referência de configuração.

**Troca rápida via comando:**

```bash
/gsd-config --profile balanced   # Desenvolvimento normal
/gsd-config --profile budget     # Prototipagem ou fases de alto custo
/gsd-config --profile quality    # Lançamento em produção
/gsd-config --profile inherit    # OpenRouter, modelos locais
```

**Ou edite `.planning/config.json` diretamente:**

```json
{
  "model_profile": "balanced"
}
```

---

## Substituições por agente (`model_overrides`)

Se um único agente precisa de um nível diferente sem alterar o perfil inteiro, use `model_overrides`:

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "gsd-executor": "opus",
    "gsd-codebase-mapper": "haiku"
  }
}
```

Valores válidos: `opus`, `sonnet`, `haiku`, `inherit` ou qualquer ID de modelo totalmente qualificado (ex.: `"openai/o3"`, `"google/gemini-2.5-pro"`).

`model_overrides` pode ser definido por projeto em `.planning/config.json` ou globalmente em `~/.gsd/defaults.json`. Entradas por projeto têm precedência em conflitos; entradas globais sem conflito são preservadas.

**Importante para Codex e OpenCode:** Esses runtimes incorporam o modelo resolvido na configuração estática de cada agente no momento da instalação. Após editar `model_overrides`, execute novamente o instalador para que a alteração entre em vigor:

```bash
npx @opengsd/gsd-core@latest --codex --global   # ou --opencode, --kilo, etc.
```

---

## Modelos por tipo de fase (`models`)

Se você quer dizer "Opus para planejamento, Sonnet para todo o resto" sem precisar aprender todos os 33 nomes de agentes, use o bloco `models`. Ele mapeia seis tipos de fase para aliases de nível:

```json
{
  "model_profile": "balanced",
  "models": {
    "planning":      "opus",
    "discuss":       "opus",
    "research":      "sonnet",
    "execution":     "opus",
    "verification":  "sonnet",
    "completion":    "sonnet"
  }
}
```

Tipos de fase e seus agentes:

| Tipo de fase | Agentes cobertos |
|---|---|
| `planning` | `gsd-planner`, `gsd-roadmapper`, `gsd-pattern-mapper` |
| `research` | `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-research-synthesizer`, `gsd-codebase-mapper`, `gsd-ui-researcher` |
| `execution` | `gsd-executor`, `gsd-debugger`, `gsd-doc-writer` |
| `verification` | `gsd-verifier`, `gsd-plan-checker`, `gsd-integration-checker`, `gsd-nyquist-auditor`, `gsd-ui-checker`, `gsd-ui-auditor`, `gsd-doc-verifier`, `gsd-code-reviewer` |
| `discuss` | `gsd-assumptions-analyzer` |
| `completion` | Reservado — nenhum subagente hoje; aceito pelo esquema para compatibilidade futura |

O bloco `models` aceita apenas aliases de nível (`opus`, `sonnet`, `haiku`, `inherit`). Para um ID de modelo totalmente qualificado, use `model_overrides` por agente.

**Combinando `models` com uma exceção por agente:**

```json
{
  "model_profile": "balanced",
  "models": {
    "research": "sonnet"
  },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

Todos os cinco agentes de pesquisa resolvem para `sonnet` *exceto* `gsd-codebase-mapper`, que está fixado em `haiku`.

---

## Roteamento dinâmico — comece barato, escale em caso de falha

Se você quiser pagar pelos níveis mais baratos por padrão e só escalar quando um agente falhar em um controle de qualidade, habilite `dynamic_routing`:

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

Cada agente possui um nível padrão (`light`, `standard` ou `heavy`). Na primeira tentativa, o GSD escolhe `tier_models[default_tier]`. Se o orquestrador detectar uma falha suave (verificação inconclusiva, verificação de plano sinalizada, etc.), ele reinicia o agente um nível acima. `max_escalations` limita o total de novas tentativas.

Agentes que já estão em `heavy` não podem escalar mais.

**Desativar a escalada mantendo a resolução dinâmica:**

```json
{
  "dynamic_routing": {
    "enabled": true,
    "escalate_on_failure": false
  }
}
```

Cada tentativa usa `tier_models[default_tier]` independentemente do resultado — útil quando você quer mapeamento explícito de nível para modelo sem o comportamento de escalada.

`dynamic_routing` está **desabilitado por padrão**. Omitir o bloco ou definir `enabled: false` preserva a resolução estática.

---

## Usando o GSD em runtimes não-Anthropic

Se você instalou o GSD para Codex, OpenCode, Gemini CLI ou Kilo, o instalador já definiu `resolve_model_ids: "omit"` na sua configuração. Isso instrui o GSD a pular a resolução de IDs de modelo Anthropic e deixar o runtime escolher seu próprio modelo padrão. Nenhuma configuração manual é necessária para o caso básico.

**Se você quiser modelos por nível no Codex:**

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

O GSD resolve cada alias de nível para o modelo nativo do Codex e o esforço de raciocínio definido no mapa de nível do runtime.

**Se você quiser IDs de modelo por agente em qualquer runtime não-Claude:**

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner":   "o3",
    "gsd-executor":  "o4-mini",
    "gsd-debugger":  "o3"
  }
}
```

Para a referência completa de perfis cientes de runtime e a superfície `model_policy` (predefinições neutras em relação ao provedor adicionadas na v1.42), consulte [Referência de configuração — Perfis de Modelo](../CONFIGURATION.md#model-profiles).

---

## Precedência de resolução (maior para menor)

Quando múltiplas camadas se aplicam, o resolvedor escolhe a entrada de maior prioridade:

```text
1. model_overrides[<agent>]           — por agente; IDs completos; exceção direcionada
2. dynamic_routing.tier_models[<tier>] — quando habilitado; escala em falha suave
3. models[<phase_type>]               — nível de fase grosseiro
4. model_profile (coluna por agente)  — estratégia global de nível
5. Padrão do runtime                  — quando nada mais se aplica
```

---

## Escolhendo o controle certo

| O que você quer | Use |
|---|---|
| Uma estratégia de nível para todos os agentes | `model_profile` |
| Ajuste grosseiro por fase ("Opus para planejamento") | `models.<phase_type>` |
| Precisão por agente ("forçar Haiku no mapeador de base de código") | `model_overrides[<agent>]` |
| Um ID de modelo totalmente qualificado para um agente específico | `model_overrides[<agent>]: "openai/gpt-5"` |
| Começar barato, escalar apenas em falha | `dynamic_routing` |
| Todos os agentes seguem o modelo da sessão (provedor não-Anthropic) | `model_profile: "inherit"` |

---

## Relacionados

- [Referência de configuração](../CONFIGURATION.md)
- [Orquestração multi-agente](../explanation/multi-agent-orchestration.md)
- [Referência de comandos](../COMMANDS.md)
- [Índice da documentação](../README.md)
