# Como instalar o GSD Core no seu ambiente de execução

Instale o GSD Core (`@opengsd/gsd-core`) no ambiente de codificação com IA que você usa no dia a dia. Este guia apresenta o caminho padrão de instalação para cada ambiente suportado e, em seguida, cobre o caminho manual para máquinas sem Node.js.

**O que você precisa:** Node.js 18+ e npm (ou npx). Se você não tem Node.js, vá para [Instalando sem Node.js](#instalando-sem-nodejs).

---

## Por que o instalador é necessário

O GSD Core distribui arquivos de agente e comando no formato nativo de frontmatter do Claude Code. Cada ambiente suportado espera um schema, layout de diretório e sintaxe de invocação de comandos diferente. O instalador realiza as transformações necessárias — por exemplo, convertendo listas de ferramentas e valores de cor para o OpenCode, escrevendo entradas TOML de agente para o Codex e reescrevendo o corpo de cada comando do formato com hífen (`/gsd-update`) para o formato com dois-pontos (`/gsd-update`) para o Gemini CLI.

**Não copie arquivos de `agents/` ou `commands/` diretamente.** Fazer isso ignora as transformações e produz erros de validação de schema ou comandos ausentes.

---

## Instalação padrão

Execute o instalador a partir de qualquer diretório. Ele solicita o seu ambiente e se a instalação deve ser global (todos os projetos) ou local (apenas este projeto).

```bash
npx @opengsd/gsd-core@latest
```

Esse é o único comando necessário para uma instalação nova ou para executar o instalador novamente após trocar de ambiente.

---

## Instruções por ambiente

### Claude Code

```bash
npx @opengsd/gsd-core@latest --claude --global
```

As habilidades são instaladas em `~/.claude/`. Os comandos aparecem como slash commands `/gsd-*` na sua próxima sessão do Claude Code. Reinicie o Claude Code para carregá-los.

**Substituir o diretório de instalação:**

```bash
CLAUDE_CONFIG_DIR=~/.claude-alt npx @opengsd/gsd-core@latest --claude --global
```

---

### Gemini CLI

```bash
npx @opengsd/gsd-core@latest --gemini --global
```

As habilidades são instaladas em `~/.gemini/`. O instalador reescreve todos os corpos de comando para o namespace de dois-pontos do Gemini (`/gsd-update`, `/gsd-config`, etc.). Reinicie o Gemini CLI após a instalação.

**Substituir o diretório de instalação:**

```bash
GEMINI_CONFIG_DIR=~/.gemini-alt npx @opengsd/gsd-core@latest --gemini --global
```

---

### OpenCode

```bash
npx @opengsd/gsd-core@latest --opencode --global
```

As habilidades são instaladas em `~/.config/opencode/` (XDG) ou `~/.opencode/`. O instalador converte o frontmatter dos agentes para o schema do OpenCode — removendo o campo `tools:` e convertendo valores de cor para hex. Consulte [Instalando sem Node.js — transformações do OpenCode](#opencode--transformações-necessárias) se você precisar entender o que muda.

**Substituir o diretório de instalação:**

```bash
OPENCODE_CONFIG_DIR=~/.config/opencode-alt npx @opengsd/gsd-core@latest --opencode --global
```

---

### Kilo

```bash
npx @opengsd/gsd-core@latest --kilo --global
```

As habilidades são instaladas em `~/.config/kilo/` (XDG) ou `~/.kilo/`. Usa o mesmo formato de comando markdown plano no estilo OpenCode.

**Substituir o diretório de instalação:**

```bash
KILO_CONFIG_DIR=~/.config/kilo-alt npx @opengsd/gsd-core@latest --kilo --global
```

---

### Codex

```bash
npx @opengsd/gsd-core@latest --codex --global
```

As habilidades são instaladas em `~/.codex/skills/gsd-*/SKILL.md`. Os agentes são registrados com entradas TOML por agente em `config.toml`. Reinicie o Codex (ou execute `codex --reload`) após a instalação.

**Versão mínima suportada:** Codex CLI 0.130.0. Versões anteriores tinham varredura adicional de raiz de habilidades que pode produzir listagens duplicadas.

---

### GitHub Copilot

```bash
npx @opengsd/gsd-core@latest --copilot --global
```

As habilidades são instaladas em `~/.copilot/`. O GSD é instalado como arquivos de agente `.md` e arquivos de instrução de repositório.

**Substituir o diretório de instalação:**

```bash
COPILOT_CONFIG_DIR=~/.copilot-alt npx @opengsd/gsd-core@latest --copilot --global
```

---

### Cursor

```bash
npx @opengsd/gsd-core@latest --cursor --global
```

As habilidades são instaladas em `~/.cursor/`. O GSD instala habilidades, agentes e referências de regras.

**Substituir o diretório de instalação:**

```bash
CURSOR_CONFIG_DIR=~/.cursor-alt npx @opengsd/gsd-core@latest --cursor --global
```

---

### Windsurf

```bash
npx @opengsd/gsd-core@latest --windsurf --global
```

As habilidades são instaladas em `~/.codeium/windsurf/`. O GSD instala habilidades, agentes e regras de workspace.

**Substituir o diretório de instalação:**

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-alt npx @opengsd/gsd-core@latest --windsurf --global
```

---

### Cline

O Cline usa uma integração baseada em regras — o GSD é instalado como `.clinerules` em vez de slash commands.

```bash
# Instalação global (todos os projetos)
npx @opengsd/gsd-core@latest --cline --global

# Instalação local (apenas este projeto)
npx @opengsd/gsd-core@latest --cline --local
```

Instalações globais escrevem em `~/.cline/`. Instalações locais escrevem em `./.cline/`. As regras são carregadas automaticamente pelo Cline — nenhum slash command personalizado é registrado.

---

### CodeBuddy

```bash
npx @opengsd/gsd-core@latest --codebuddy --global
```

As habilidades são instaladas em `~/.codebuddy/skills/gsd-*/SKILL.md`.

---

### Qwen Code

O Qwen Code usa o mesmo padrão de habilidades abertas do Claude Code 2.1.88+.

```bash
npx @opengsd/gsd-core@latest --qwen --global
```

As habilidades são instaladas em `~/.qwen/skills/gsd-*/SKILL.md`.

**Substituir o diretório de instalação:**

```bash
QWEN_CONFIG_DIR=~/.qwen-alt npx @opengsd/gsd-core@latest --qwen --global
```

---

### Augment Code

```bash
npx @opengsd/gsd-core@latest --augment --global
```

As habilidades são instaladas em `~/.augment/`. O GSD instala habilidades e agentes. Sem posse de hook ou statusline.

---

### Antigravity

```bash
npx @opengsd/gsd-core@latest --antigravity --global
```

O instalador detecta automaticamente o diretório de configuração do Antigravity (`~/.gemini/antigravity`, `~/.gemini/antigravity-ide` ou `~/.gemini/antigravity-cli`). Usa a política de configurações compatível com Gemini.

**Substituir o diretório de instalação:**

```bash
ANTIGRAVITY_CONFIG_DIR=~/.gemini/antigravity-alt npx @opengsd/gsd-core@latest --antigravity --global
```

---

### Trae

```bash
npx @opengsd/gsd-core@latest --trae --global
```

As habilidades são instaladas em `~/.trae/`. O GSD instala habilidades, agentes e referências de regras.

---

## Instalação local vs global

Todos os exemplos acima usam `--global`, que instala o GSD uma vez para a sua conta de usuário. Para limitar uma instalação a um único projeto, substitua `--global` por `--local`:

```bash
npx @opengsd/gsd-core@latest --claude --local
```

Uma instalação local escreve no diretório `.claude/` na raiz do seu projeto. As configurações de instalação local têm precedência sobre as globais quando ambas existem.

---

## Instalando edições de pré-lançamento (Next / Nightly / Insiders / Preview)

As edições de pré-lançamento dos ambientes (Windsurf Next, Cursor Nightly, VS Code Insiders, canais de preview do Codex, etc.) leem de um diretório de configuração irmão. Defina a variável de ambiente `*_CONFIG_DIR` correspondente antes de executar o instalador:

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-next npx @opengsd/gsd-core@latest --windsurf --global
```

Selecione o ambiente estável correspondente no prompt do instalador. O GSD não enumera as edições de pré-lançamento como ambientes nomeados separados — elas são suportadas com melhor esforço por meio desse mecanismo de variável de ambiente e não são testadas separadamente no CI de lançamento.

---

## Instalando sem Node.js

Se você não pode executar `npx` (por exemplo, em uma máquina Windows sem Node.js), você tem duas opções.

**Opção A — Use uma máquina que tenha Node.js.** Qualquer máquina com Node.js serve: WSL, uma VM Linux, um runner de CI ou um contêiner Docker. Execute o instalador lá e, em seguida, copie o diretório de saída para a sua máquina de destino. Para o OpenCode:

```bash
npx @opengsd/gsd-core@latest --opencode --global
# Depois copie ~/.config/opencode/agents/ para a máquina Windows
```

**Opção B — Transforme manualmente os arquivos-fonte.** Os arquivos-fonte dos agentes estão em `agents/` no repositório do GSD Core e estão no formato nativo de frontmatter do Claude Code. Cada ambiente espera um formato diferente. Para as transformações de campo exatas por ambiente, consulte [Instalação manual / configuração sem Node.js](../USER-GUIDE.md#manual-install--no-nodejs-setup) no Guia do Usuário, que cobre as transformações do OpenCode em detalhes completos e aponta para as funções `convert*Frontmatter` do instalador para outros ambientes.

---

## Após a instalação

Reinicie seu ambiente para carregar os novos comandos e agentes. Em seguida, inicie um projeto novo ou faça onboarding de um repositório existente:

```bash
/gsd-new-project   # projeto greenfield
/gsd-onboard       # base de código existente
```

Se o comando não for encontrado após o reinício, verifique se o diretório de instalação corresponde ao caminho de configuração esperado pelo ambiente. A seção de edições de pré-lançamento acima cobre a incompatibilidade mais comum.

---

## Relacionados

- [Seu primeiro projeto](../tutorials/your-first-project.md)
- [Atualizar o GSD Core](update-gsd.md)
- [Configuração](../CONFIGURATION.md)
- [Índice da documentação](../README.md)
