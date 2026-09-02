# anthive

Projetos, agentes e o que os liga — dentro do terminal que você já usa.

Não é um emulador de terminal: é uma TUI que roda no Ghostty (ou no que você
tiver). Lê os transcripts que o Claude Code grava em `~/.claude/projects` e
desenha por cima um grafo de **projetos → itens → relações**.

```bash
cd ~/Documents/Anthive && bun run build     # gera ./ai
ai                                            # tela de projetos
ai pedidos                                    # abre um projeto direto
```

## Tela inicial: projetos

Um cartão por projeto — os que você registrou e os diretórios onde há sessão
do Claude Code na última hora — e o `+ Novo` no fim. Setas escolhem, `↵` entra,
`n` abre o modal de projeto novo (nome e diretório; o diretório é criado se
não existir).

## Tela do projeto

Agentes à **esquerda**; notas, arquivos e serviços à **direita**; as relações
no meio. Cada ligação sai do agente, atravessa a calha numa faixa própria e
entra no item com uma seta `▸`. Conversa entre agentes é traço grosso com o
turno (`⇄ 2/6`). O pulso `●` corre do agente para o que ele está ligado.

| tecla | faz |
|---|---|
| setas, `tab` | navegam pelos nós |
| `↵` | abre o nó — cada tipo tem a sua tela |
| `n` | novo: agente, nota, arquivo ou serviço (serviço puxa o que está escutando porta nesta máquina, via `lsof`) |
| `l` | ligar: marca a origem, você anda até o destino, `↵` confirma |
| `d` | remover, com confirmação |
| `esc` | volta aos projetos |

Ligar tem semântica pelo par: agente ⇄ agente abre uma **conversa** (pede só o
objetivo — obrigatório por desenho, com teto de turnos); agente → nota dá
**leitura** (a nota entra na ACL do agente no barramento); o resto é
**associação** no grafo do projeto.

Sessões do Claude Code no diretório aparecem como agentes sozinhas, sem
registrar nada. Elas não se removem — são do disco.

## As telas por tipo

**Agente** — a árvore do que ele fez (turnos recolhidos em linha-resumo, `↵`
abre), a faixa `ligado a`, e uma caixa de escrita: `i` abre, `↵` envia, a
resposta entra na árvore ao vivo. O que você escreveu e o que ele respondeu
**quebram em linhas**, com parágrafos preservados, para se ler inteiro;
comandos de ferramenta ficam numa linha só. Redimensionar reflui o texto. `m` modelo, `e` esforço, `p` permissão — em
lista, viram `--model`, `--effort`, `--permission-mode`. `l` liga a outro nó do
projeto por uma lista. Por baixo é um `claude -p --input-format stream-json`
vivo na sessão do agente; escreve no mesmo `.jsonl`.

Com 110 colunas ou mais, a tela do agente ganha um **painel à direita** —
memória (contexto, modelo, esforço, eventos, queima, custo do chat, quantos
blocos de raciocínio existem), ligações, tarefas (as `TaskCreate`/`TaskUpdate`
do próprio Claude Code, reconstruídas do transcript) e o estado de agora. `]`
esconde. As respostas do agente são renderizadas como **markdown**: títulos,
listas, código, ênfase e links viram cor. `t` mostra o **raciocínio** gravado
(o modelo expõe blocos de pensamento; a árvore os traz apagados, sob cada
ação). `y` copia o turno sob o cursor para o clipboard (`pbcopy`). Quando uma
resposta termina, o terminal toca o sino.

**Nota** — o texto renderizado como markdown; `e` edita no `$EDITOR`, `d`
apaga, `l` liga. Arquivo `.md` (o `CLAUDE.md`, por exemplo) também vem
renderizado.

**Arquivo** — as primeiras linhas com numeração; `e` abre no `$EDITOR`, `d`
desliga do projeto (o arquivo fica).

**Serviço** — pid, porta, comando, diretório, tempo no ar, cpu e memória
(`ps`). Serviço não se edita: `k` encerra (SIGTERM, com confirmação), `d`
remove do projeto. Logs de processo alheio não existem — a tela diz isso em
vez de fingir.

## Agente novo descobre as relações sozinho

Ao criar um agente com uma instrução, o anthive monta um **briefing** com o
mapa do projeto — agentes, notas, arquivos, serviços vivos e as relações
atuais — e explica como usar cada coisa: notas pelo barramento (`note_read`),
outros agentes por `send_message` com objetivo, arquivos pelos caminhos,
serviços pelas portas. Pede que ele responda primeiro `ligar: a, b` (ou
`ligar: nada`). Quando o turno termina, o anthive lê a resposta no transcript
e cria as ligações que ele escolheu.

O turno roda com `claude -p --session-id <uuid>` em segundo plano — verificado:
o transcript nasce com o id escolhido e `--resume` continua nele. Sem tmux um
`claude` interativo morre em ~1 s; por isso agente sem tmux é uma **sessão
nomeada**, não um processo.

## Tarefas, diff e o painel do projeto

**Tarefas são nós do mapa.** O Claude Code mantém tarefas com `TaskCreate` e
`TaskUpdate`; o anthive as lê do transcript de cada agente (com cache por
tamanho de arquivo) e pendura no agente uma caixa `task` por tarefa aberta —
`○` pendente, `◉` em andamento, `●` concluída (as duas últimas concluídas
ficam). `↵` abre a tarefa: título, descrição em markdown, estado, de quem é.
Tarefa não se cria nem se remove daqui — é do agente.

**Diff do que ele editou.** Na tela do agente, linhas de `Edit`, `MultiEdit`
e `Write` vêm marcadas com `↵ diff`; `↵` abre o diff por linhas: `−` vermelho,
`+` verde, contexto apagado, `+n −m` no cabeçalho. `Write` é tudo novo.
Entradas acima de 64 KB não são guardadas; a tela diz isso em vez de quebrar.

**Painel à direita no projeto.** A partir de 110 colunas, o nó selecionado
ganha um painel com o que vale saber sem entrar nele: agente (estado,
contexto, modelo, branch, o que faz agora, tarefas, ligações), nota (vida,
quem lê, conteúdo), arquivo, tarefa (descrição), serviço. `]` esconde.

## Browser: a página ao vivo dentro do terminal

`n → browser` põe um Chrome **só do projeto** no mapa. O anthive é dono do
processo: sobe um Chrome for Testing (o do Playwright; senão o Google Chrome)
com perfil próprio em `~/.anthive/browsers/<id>` e uma porta de depuração
fixa. O Playwright do agente não abre browser nenhum — liga nesse Chrome por
CDP (`--cdp-endpoint` no `.mcp.json`) — e o anthive lê a **mesma página** por
CDP: screencast, clique, rolagem, texto.

Dois modos, trocáveis com `o` na tela do browser (mesmo perfil, logins ficam;
o agente reconecta sozinho):

- **oculto** (padrão): headless. Sem janela, sem ícone no Dock, sem roubar o
  foco. A página aparece **ao vivo dentro do anthive**, e você clica nela.
- **janela**: o Chrome abre na tela, mas nasce sem janela inicial
  (`--no-startup-window`) e a janela que o agente cria não rouba o foco.

Ligue um agente com `l` e abra o chat (`i`): o anthive sobe o Chrome antes
do processo do Claude e instrui o agente como o Maestri ensina o portal —
**snapshot primeiro** (a árvore de acessibilidade com refs), refs como seletor
em click/type, screenshot só para ver layout, nunca fechar sozinho, e que a
página é compartilhada com você.

O que você vê: no mapa, a caixa `browser` com `● ao vivo`, título e URL vindos
do Chrome; no painel, os refs do último snapshot com o **ref na frente**
(`e3  link "Novo"`), que é o que o agente clica; na árvore do chat, `▣ navigate
https://…`, `▣ click "Novo"`. Em `↵`, a tela do browser: a **página ao vivo**
desenhada dentro do terminal pelo protocolo gráfico do Kitty (Ghostty), com a
proporção certa (o anthive pergunta o tamanho da célula em pixels, `CSI 16 t`),
e à direita o que o agente vê. Clique na página, `↑↓` rola, `i` digita (esc
sai), `r` recarrega, `o` troca oculto ⇄ janela. Num terminal sem imagens, a
tela mostra o snapshot em texto.

Coisas que só apareceram rodando de verdade: no transcript as ferramentas
chegam como `mcp__playwright__browser_*` e podem vir adiadas (o agente carrega
com `ToolSearch`; a instrução diz como); `browser_navigate` devolve só URL,
título e o caminho de um arquivo, não o snapshot; o Playwright grava em
`.playwright-mcp/` dentro do projeto (o anthive põe a pasta no
`.git/info/exclude`); minimizar ou ocultar a janela do Chrome **para de
renderizar** (o screencast morre), por isso oculto = headless, não janela
escondida; o Chrome oculto sobe em sessão própria (`setsid` via perl), senão
morre junto com o terminal.

Testes: `bun run test:chrome` sobe um Chrome oculto de verdade, recebe a
página ao vivo e clica nela (sem API); `bun run test:browser` é o ponta a
ponta com um agente haiku por esse Chrome (uns 5 centavos).

## Contexto de ambiente: o `CLAUDE.md`

O Claude Code já tem a "nota de contexto do projeto": o **`CLAUDE.md`** na
raiz, que ele lê em toda sessão, e o comando **`/init`**, que o gera analisando
o repositório. Há ainda a memória automática por projeto em
`~/.claude/projects/<slug>/memory/MEMORY.md`. O anthive não reinventa isso:

- `CLAUDE.md` (ou `.claude/CLAUDE.md`) e `MEMORY.md` aparecem no mapa como
  **arquivos de contexto**, descobertos sozinhos, ligados a **todo agente** do
  projeto — porque é assim que o Claude os usa.
- Agente novo com instrução e **sem `CLAUDE.md`**: a sessão dele roda o
  `/init` primeiro (verificado em modo `-p`: gera o arquivo de verdade) e só
  então recebe o briefing, já com `--resume`. O briefing manda ler o
  `CLAUDE.md` antes de qualquer coisa e completá-lo se estiver fraco.
- `n → contexto` no projeto: abre o `CLAUDE.md` se existe; se não, gera com o
  `/init` numa sessão nova, em segundo plano — quando o arquivo aparece, ele
  entra no mapa sozinho.

## Onde as coisas ficam

```
~/.anthive/projects.json          registro: id, nome, diretório
~/.anthive/projects/<id>.json     grafo: agentes, arquivos, serviços, ligações
~/.anthive/notes/*.md             notas (frontmatter com project e acl)
~/.anthive/threads/*.md           conversas entre agentes, append-only
```

Tudo é arquivo: grepável, versionável, editável.

## O barramento

O Claude Code carrega o `.mcp.json` do diretório onde a sessão roda — em modo
`-p` também, sem flag (verificado: `anthive: connected`). Então o anthive
**grava a entrada `anthive` no `.mcp.json` do projeto sozinho** antes de subir
um chat ou o primeiro turno de um agente novo. Só acrescenta a entrada; o que
já existir no arquivo fica. É um arquivo normal do repositório — aparece no
`git status`; commite ou ignore, como preferir.

Com o barramento na sessão, um pedido como *"crie uma nota do ambiente deste
projeto e ligue-se a ela"* faz o agente chamar `note_write`: a nota nasce no
projeto, já ligada a ele, e aparece no mapa pendurada nele. `project_map` dá ao
agente a visão do projeto a qualquer momento — não só no briefing.

Em modo `-p` não existe prompt de permissão: uma ferramenta não autorizada é
**negada** e o agente fica sem saída (aconteceu: "permissão necessária para
mcp__anthive__note_write… sessão não-interativa"). Por isso todo chat e todo
primeiro turno sobem com `--allowedTools mcp__anthive` — o servidor inteiro
pré-autorizado, verificado: a nota nasce no projeto, ligada ao agente, sem
negação. A flag é variádica; ela nunca fica imediatamente antes do prompt.

Todo chat e todo primeiro turno vão com `--append-system-prompt` dizendo ao
agente que ele está no anthive e que nota, ligação, conversa e mapa são as
ferramentas `anthive`. Sem isso, skills de outros canvases instaladas
globalmente (Maestri, nodeterm) capturam "criar nota" e "ligar agente" — foi o
que aconteceu na primeira tentativa. Conteúdo que o Claude Code injeta (uma
skill carregada, um lembrete) aparece na árvore como `▸ skill <nome>`, nunca
como fala sua.


`ai install-mcp` (no diretório do projeto) grava o `.mcp.json`; cada agente
sobe com o servidor e se identifica por `ANTHIVE_AGENT`. Ferramentas:
`agents_list`, `inbox`, `send_message`, `thread_*`, `notes_list`, `note_read`,
`note_write`. Conteúdo de outro agente chega embrulhado como **dado**, não
instrução. Conversa nasce com objetivo e teto de turnos; só você estende.

## A regra do alinhamento

Grade de caracteres não perdoa glifo de largura errada. `src/tui/theme.ts`
só aceita box drawing, blocos, braille e uma lista curta de símbolos
verificados; qualquer outro vira `?` vermelho. Conteúdo é truncado antes de
desenhar, nunca empurra borda. `python3 test/screenshot.py COLS ROWS [teclas]`
roda o binário num pseudo-terminal e imprime a tela — é assim que cada tela
daqui foi conferida. `ANTHIVE_OPEN=<projeto>` abre direto num projeto.

## Estrutura

```
src/tui/            grade, diff, cursor, teclado, mouse, formulários
src/core/project.ts projetos, grafo, descoberta, agentes, briefing
src/core/services.ts serviços pelo lsof, stats pelo ps
src/core/sessions.ts transcripts do Claude Code
src/core/store.ts    notas e conversas em markdown
src/core/bus.ts      ACL, caixa de entrada, teto de turnos
src/core/chat.ts     claude -p em stream-json, uma sessão por chat
src/mcp/server.ts    JSON-RPC 2.0 sobre stdio
src/views/           home · project · agent · item · prompt · chrome
src/app.ts           a máquina de estados
```

## Testes

```bash
bun run test        # input, barramento, serviços (lsof real), MCP — sem rede
bun run test:chat   # sobe um claude de verdade (~$0,03)
bun run shot 100 28 ENTER   # captura de tela real
```
