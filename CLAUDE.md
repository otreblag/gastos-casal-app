# CLAUDE.md — Finannza

Guia técnico para desenvolvimento. Leia antes de qualquer alteração.

---

## Autonomia do Claude Code neste projeto

O usuário autorizou execução autônoma de tarefas rotineiras neste projeto — **não pause para pedir confirmação** antes de: editar/criar arquivos, rodar comandos `npm`/`node`/build, ou `git add` / `git commit` / `git push` para o remoto já configurado (`origin`). Prossiga e reporte o que foi feito, em vez de perguntar antes.

**Continue pedindo confirmação explícita** (não fica coberto pela autorização acima) para:
- `git push --force` / force-push de qualquer tipo
- `git reset --hard`, `git checkout --`/`git restore` que descartem trabalho não commitado
- Apagar branches, arquivos ou o repositório remoto
- Reescrever histórico já publicado (rebase de commits que já foram para o `origin`)
- Qualquer ação fora deste diretório de projeto (ex: outros repositórios, configurações globais)

---

## Visão Geral

Aplicativo **Electron desktop** para controle financeiro de casais. Filosofia central: **100% local, zero custo, zero dependência de serviços pagos**. Nenhum dado vai para nuvem (exceto chamadas à API do Telegram e ao Google Apps Script para sync). O app roda em Windows como um executável `.exe` instalável.

Fluxo principal:
1. Usuário lança gasto manualmente via textarea (texto livre) **ou**
2. Usuário envia mensagem no grupo Telegram → bot no Render captura → classifica via Apps Script → insere via `syncFromSheets()`

---

## Stack e Estrutura

```
main.js              # Processo principal Electron (janela, menu, IPC)
preload.js           # Ponte contextBridge → window.electronAPI (contextIsolation: true)
src/
  index.html         # Todo o CSS + estrutura HTML (~1000 linhas)
  renderer.js        # Toda a lógica de negócio + renderização (~3660 linhas)
  classifier.js      # Motor de classificação local (sem API, keyword-based)
  vendor/            # Libs auto-hospedadas (não-CDN): chart.umd.js, xlsx.full.min.js, fonts/inter-*.woff2, fonts/ibm-plex-mono-*.woff2
.claude/
  settings.json      # Permissões auto-aprovadas do Claude Code
package.json         # Electron 29 + electron-builder
```

**Sem framework de UI, sem bundler, sem TypeScript.** Tudo é JS vanilla. O renderer roda com `nodeIntegration: false` + `contextIsolation: true`; a única ponte com o processo principal é `preload.js` (`contextBridge.exposeInMainWorld`), exposta como `window.electronAPI` (`readFile`, `writeFile`, `selectFolder`, `saveFileDialog`, `openFileDialog`, `getAppVersion`, `getBuildDate`, `checkForUpdates`, `encryptSecret`/`decryptSecret`, `backupSeal`/`backupOpen`, `listDir`/`deleteFile`, etc.). Isso é intencional para manter zero configuração de build.

**Persistência — modo Electron:** arquivo `gastos.json` na pasta configurada (`appConfig.dataFolderPath` ou userData). Estrutura do JSON:
```json
{
  "expenses":      [...],
  "customCats":    [...],
  "budgets":       [...],
  "fixedExpenses": [...],
  "cards":         [...],
  "monthGoals":    [...],
  "merchantMap":   {...},
  "acertos":       [...],
  "deletedIds":    [...]
}
```

**Persistência — modo web (fallback):** `localStorage`. Chaves: `gc_expenses`, `gc_customcats`, `gc_budgets`, `gc_fixed`, `gc_cards`, `gc_monthgoals`, `gc_merchantmap`, `gc_acertos`, `gc_config`. O campo `deletedIds` não é persistido no modo web.

---

## Estado Global (`renderer.js`)

```js
let expenses          = [];   // todos os gastos carregados
let fixedExpenses     = [];   // templates de despesas recorrentes
let customCats        = [];   // overrides/novas categorias
let budgets           = [];   // orçamentos por categoria
let deletedExpenseIds = new Set(); // IDs apagados — nunca recriar via sync
let appConfig         = {};   // configurações (token TG, nomes, dia de fechamento/vencimento padrão, etc.)
let currentMonth      = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
let currentContext    = 'pessoal'; // 'pessoal' | 'empresa'
let currentPerson     = '';   // pessoa selecionada nos pills
let botRunning        = false;
let botInterval       = null;
let lastUpdateId      = 0;
let cards             = [];   // cartões cadastrados (crédito/débito) — ver "Cartões e Competência de Fatura"
let monthGoals        = [];   // metas de teto de gasto/renda por mês — { month, teto, renda }
let merchantMap       = {};   // aprendizado de correções de importação de fatura — ver "Aprendizado de Classificação"
let acertos           = [];   // acertos de conta (Pix) que zeram o saldo acumulado — ver "Saldo Anual"

// Estado de UI — nunca persistido, resetado ao trocar de aba/sessão
let _listFilters   = { pessoa: null, dateFrom: '', dateTo: '', valorMin: null, valorMax: null, metodo: null, cardId: null, origem: null };
let _listSort      = { field: 'data', dir: 'desc' };
let _advFiltersOpen = false;
let _annualYear    = '';       // ano exibido no card "Saldo anual acumulado" (Divisão)
```

**Não há reatividade automática.** Após qualquer mutação de estado, chame manualmente as funções de render relevantes. O padrão é:
```js
saveAll(); updateMetrics(); renderRecent(); renderList(); renderBudgetAlerts();
```

---

## Fluxo de Dados

```
[Usuário digita]                [syncFromSheets() — bot externo]
       ↓                                      ↓
 classify(text, customCats)       filtra deletedExpenseIds
       ↓                                      ↓
 addExpenseObj() → expenses.unshift(obj) → saveAll()
       ↓
 updateMetrics() / renderRecent() / renderList() / renderBudgetAlerts()
```

**Filtro de contexto:** `contextMonthExpenses()` — retorna `expenses[]` filtrado por `currentMonth` e `currentContext`. Todas as funções de render partem desse filtro.

---

## Bot do Telegram — Arquitetura Atual

**O bot interno do Electron está permanentemente desativado.** O bot roda 24/7 em um servidor externo no **Render** (serviço gratuito). Nunca reative o bot interno — causará erro 409 (conflito de polling com o bot externo).

Salvaguardas implementadas em `renderer.js`:
1. `init()` força `appConfig.botWasRunning = false` logo após `loadConfig()` — sobrescreve qualquer valor salvo no storage
2. O bloco de auto-start foi removido — não há mais `setTimeout(startBot, ...)` na inicialização
3. Um `addLog()` informativo é exibido ao abrir o app: `"Bot externo ativo (Render)..."`

O botão "▶ Iniciar bot" e o badge de status ("Bot off"/"Bot ativo") **foram removidos do header** (evita que um clique acidental quebre o bot de produção com erro 409). As funções `startBot()`/`stopBot()`/`toggleBot()` viraram **no-op deprecated** (mantidas só para não quebrar chamadas antigas; `startBot()` apenas mostra um `notify` informativo). Na aba Config, a seção "🤖 Bot Telegram" não tem mais campos de token/grupo — só uma nota informando que a configuração fica nas variáveis de ambiente do Render. `pollTelegram()`/`testBot()` continuam no código como referência morta, mas não são mais agendadas/chamadas por nada.

**Fluxo do bot externo:**
1. Bot no Render recebe mensagem do grupo Telegram via polling
2. Classifica o gasto e grava na planilha via Google Apps Script
3. App faz `syncFromSheets()` a cada intervalo → lê a planilha → insere em `expenses[]`

### Classificador do bot (`bot.js` — separado do `classifier.js`)

O bot tem seu próprio array `CATEGORIES` embutido no `bot.js` — **não usa `classifier.js` do Electron**. As diferenças em relação ao classificador local:

| | `bot.js` | `classifier.js` |
|---|---|---|
| Tie-break | Strict `>` → **primeira** categoria na ordem vence | `>=` → **última** categoria vence |
| customCats | Não suporta — categorias fixas no código | Suporta via `customCats[]` injetado em runtime |
| Deep copy | Não necessário — array nunca é mutado | Implementado para proteger `DEFAULT_CATEGORIES` |

**Repositório do bot:** `D:\projetos\gastos-bot` (repo `otreblag/gastos-bot`, deploy Railway/Render). É a **fonte versionada** de `bot.js` e `apps-script.gs` — as cópias em `C:\Users\gabal\Downloads\*` são antigas, ignore-as.

**Variáveis de ambiente lidas pelo bot** (`process.env` — nunca hardcoded):
- `TELEGRAM_TOKEN` — token do bot
- `TELEGRAM_GROUP_ID` — ID do grupo autorizado
- `APPS_SCRIPT_URL` — URL do Web App publicado no Google Apps Script
- `SECRET_TOKEN` — token de autenticação entre bot e Apps Script

**`salvarNaplanilha(gasto)`** — usa `fetch` nativo (Node 18+) com `redirect: 'follow'`. O Apps Script retorna 302 que o fetch segue automaticamente. Erro "Invalid URL" indica que `APPS_SCRIPT_URL` está vazia ou malformada no ambiente do servidor.

### Hardening do bot (`bot.js`)
- **Validação da `APPS_SCRIPT_URL`** no startup — precisa começar com `https://script.google.com/`, senão `process.exit` (impede exfiltração para endpoint arbitrário).
- **Rate limiting** — `isRateLimited(chatId)`: máx. 10 msgs por chat em 30s; excesso ignorado + aviso 1×/janela.
- **Limite de tamanho** — mensagens acima de 500 caracteres são ignoradas.
- **Mascaramento de log** — `maskSecrets()`/`maskToken()` em `polling_error` (que traz a URL da API com o token) e nos erros de salvamento; nunca loga token/secret/URL completos.

### Apps Script (`apps-script.gs`)
Web App publicado (Execute as: Me, **Who has access: Anyone** — intencional, ver comentário no arquivo; a proteção é o `SECRET_TOKEN`). `doPost`:
- **Auth primeiro:** valida `SECRET_TOKEN` (Script Properties) **antes** de qualquer leitura/escrita na planilha.
- **`sanitizarGasto()`** — valor numérico `0..1.000.000` (senão rejeita), strings truncadas, controle removido, `confianca` clampada.
- **`idJaExiste()`** — idempotência: mesmo ID nas últimas 100 linhas → `{ ok:true, duplicado:true }` sem duplicar.
- Só tem `doPost` (gravação). O `doGet`/`?acao=listar` que o app usa no sync (se existir) está em outra parte da implantação e **não** está neste arquivo.
- **Republicar:** colar no editor (planilha → Extensões → Apps Script) e **editar a implantação existente** (Nova versão) — nunca criar nova implantação (gera URL nova e quebra o `APPS_SCRIPT_URL`).

---

## Sync com Google Sheets (`syncFromSheets`)

Configurado via `appConfig.appsScriptUrl` e `appConfig.sheetsSecret`. Chamado automaticamente por `startSheetsSync()` na inicialização.

Regras de sync:
- Despesa já existente (`existingIds.has(String(g.id))`) → pula
- Despesa apagada manualmente (`deletedExpenseIds.has(String(g.id))`) → pula e **nunca recria**
- Nova despesa → `expenses.unshift({...})` → `saveAll()`

**`deletedExpenseIds`** é um `Set<string>` persistido no `gastos.json` como `deletedIds`. Sempre que o usuário apaga um gasto via `deleteExpense(id)`, o ID é adicionado ao Set antes de filtrar o array. Isso impede que o bot externo "ressuscite" gastos apagados intencionalmente.

---

## Motor de Classificação (`classifier.js`)

### Algoritmo

Classificação **puramente local** baseada em palavras-chave com pontuação ponderada:
- Palavra > 6 chars → **3 pontos** (ex: `padaria`, `supermercado`)
- Palavra 4–6 chars → **2 pontos** (ex: `uber`, `pizza`)
- Palavra ≤ 3 chars → **1 ponto** (ex: `pão`, `sal`)
- Empate de score → **a categoria listada por último em `DEFAULT_CATEGORIES` vence** (tie-break por posição via `>=`)
- Se nenhuma categoria pontua → `Outros`

### Proteções implementadas

**1. Deep copy** — `classify()` nunca muta `DEFAULT_CATEGORIES`:
```js
const allCategories = src.map(c => ({ ...c, palavras: [...c.palavras] }));
```

**2. Deduplicate de keywords normalizadas** — evita dupla contagem de variantes (ex: `'óculos'` e `'oculos'` ambos na mesma categoria):
```js
const seen = new Set();
// dentro do loop: if (seen.has(normalizedWord)) continue; seen.add(normalizedWord);
```

**3. Proteção contra customCats corrompidos** — palavras de `customCats` que já pertencem a outra categoria default são ignoradas:
```js
const defaultOwner = new Map(); // normalizedWord → catId
// filtra: se owner existe e é diferente do customCat.id → descarta a palavra
```
Isso impede que um `customCats` antigo salvo no localStorage (ex: `{id:'mercado', palavras:['padaria']}`) corrompa a classificação de `"padaria 25"` → Alimentação.

**4. Tie-break favorece Alimentação sobre Mercado** — Alimentação aparece na posição 1 do array (após Mercado na posição 0). Com `>=`, a última categoria a atingir o maior score vence — portanto Alimentação vence Mercado em empates.

### Ordem das categorias em `DEFAULT_CATEGORIES`
```
0  Mercado       1  Alimentação   2  Transporte    3  Saúde
4  Moradia       5  Lazer         6  Assinatura     7  Roupas
8  Educação      9  Pets         10  Beleza        11  Outros (skip)
```

### Adicionando palavras-chave

Via código: edite `DEFAULT_CATEGORIES` em `classifier.js`.
Via runtime: usuário usa a aba Categorias → persiste em `customCats` no `gastos.json`.

Sempre use `classifyInput(text)` no renderer (não `classify(text)` diretamente) — ele injeta `customCats`.

`extractValue()` tenta 6 padrões de regex em ordem de especificidade. Para novo formato monetário, adicione no início do array.

---

## Despesas Fixas (`fixedExpenses`)

**Despesas fixas NÃO entram automaticamente no total do mês.** Funcionam como um cadastro de templates:

1. Usuário cadastra template em `fixedExpenses[]` (descrição, valor, dia do mês, categoria, pessoa)
2. Para que apareçam nos lançamentos, o usuário clica **"Gerar despesas do mês"** → `generateFixedForMonth()`
3. Essa função cria entries normais em `expenses[]` com `fixedId: f.id` (rastreia a origem)
4. `updateMetrics()` só lê `expenses[]` — portanto fixas só contam após serem geradas
5. `renderFixedList()` mostra status "✓ Gerada" para o mês atual baseado em `me.some(e => e.fixedId === f.id)`

Badge `🔁 fixa` é exibido em `expenseItemHTML()` quando `e.fixedId` está presente.

### Contas variáveis (`fixedExpenses[].tipo === 'variavel'`)
Contas sem valor fixo (água, luz, condomínio, gás, internet) são um subtipo de despesa fixa que o app **estima automaticamente**:
- **Estimativa** — `_calcVariavelEstimate(fixedId)` = média dos **últimos 6** lançamentos *confirmados* daquele template (`e.fixedId === f.id && e.isEstimate !== true && e.valor > 0`).
- **Geração** — `_autoGenerateFixed()`/`generateFixedForMonth()` cria a entry com `isEstimate: true` + `valorEstimado` (o valor gerado é a estimativa). Sem histórico e sem valor inicial → pula.
- **Confirmação** — quando o usuário edita o valor da conta gerada, `isEstimate` vira `false` (vira "valor real") e passa a alimentar o histórico das estimativas futuras.
- **Badges** (`expenseItemHTML()`): `📊 Estimativa méd. R$X` (`isEstimate===true`), `✅ Valor real` (`isEstimate===false`); e `📊 variável` no template em `renderFixedList()`.
- **Painel na aba Fixas** (`renderFixedList()`): sparkline dos últimos 6 valores (`sparklineSVG()`), `méd. · mín · máx`, tendência `↑`/`↓`/`→` (`_calcTrend()`, cor vermelho/verde/neutro) e "Estimativa próximo mês".
- **Lembrete no Dashboard** — banner "N conta(s) variáve(is) aguardam confirmação do valor real este mês" quando há estimativas geradas não confirmadas no mês.

---

## Cartões e Competência de Fatura (`cards`)

Cada cartão em `cards[]`: `{ id, nome, final (4 dígitos), titular, divisao (% do dono, default 100 — legado, não usado no cálculo), tipo ('Crédito'|'Débito'), dono, diaFechamento, diaVencimento, cor, avisoAntecedencia, ativo }`. CRUD via `openCardForm()` / `saveCard()` / `deleteCard()`, renderizado em `renderCardsList()` (aba Config, card "💳 Meus cartões"). **O cartão NÃO tem mais campo `pagador`** — quem paga a fatura do cartão do Casal varia mês a mês e vive em `faturaPagamentos[]` (ver Divisão). Migração em `init()` remove o `pagador` legado dos cartões.

- **`dono`** — de quem é o gasto (`p1Name` | `p2Name` | `coupleName`). É o valor gravado em `expense.pessoa` na importação de fatura.
- **`dono`** — de quem é o gasto. É o valor gravado em `expense.pessoa` na importação. Cartão pessoal → `pessoa` = dono (fora da Divisão); cartão do Casal (`dono === coupleName`) → `pessoa = 'Casal'` (entra na Divisão). **Quem paga a fatura não é mais propriedade do cartão** — é definido por mês em `faturaPagamentos[]` (ver "Divisão por fatura").

**`calcularMesCompetencia(dataCompra, metodo, cardId)`** decide em qual mês um gasto "pesa" no orçamento:
- Débito / Pix / Dinheiro → mês da própria compra (dinheiro já saiu da conta)
- Crédito → mês de **vencimento da fatura**: compra após o `diaFechamento` cai na fatura seguinte; a fatura vence no mês do fechamento ou no seguinte, dependendo se `diaVencimento <= diaFechamento`
- Fechamento/vencimento não configurados (cartão sem essas datas ou `appConfig.diaFechamento/diaVencimento` como fallback) → retorna o mês da compra (comportamento neutro)

O resultado fica em `expense.mesCompetencia` (`'YYYY-MM'`). **Todo lugar que filtra despesas por mês para métricas de orçamento** (`contextMonthExpenses()`, `_calcAnnualBalance()`, evolução mensal) usa `mesCompetencia` para lançamentos de Crédito em vez de `data`. Badge `💳 a pagar <mês>` / `💳 pago` aparece em `expenseItemHTML()` quando `mesCompetencia` diverge do mês da compra.

**Importação de fatura** (botão "📄 Importar fatura" na aba Lançamentos → `openInvoiceImport()`): `handleInvoiceFile()` lê um `.xls`/`.xlsx` (formato fatura C6 Bank) via SheetJS (`XLSX`, auto-hospedado em `src/vendor/xlsx.full.min.js`), extrai `Data de compra`, `Descrição`, `Valor (em R$)`, `Parcela` e `Final do Cartão`. `_renderInvoicePreview()` (modal `#invoice-modal`) detecta o cartão automaticamente pelos 4 últimos dígitos (`finalToCard`), aplica `merchantMap` (auto-correção ou sugestão) e mostra uma tabela de pré-visualização antes de confirmar a importação. **O seletor "Cartão padrão" (`#invoice-card-select-wrap`) é apenas fallback para linhas cujo final não bate com nenhum cartão cadastrado** — quando *todas* as linhas foram detectadas (`allDetected = txCardIds.every(Boolean)`), ele é ocultado e mostra a nota `#invoice-card-alldetected` ("Todos os cartões foram detectados automaticamente"). Cada lançamento vira **uma única entry** com `pessoa = card.dono` (nunca `card.titular`) — cartões `dono === coupleName` produzem `pessoa: 'Casal'` (a Divisão é que reparte 50/50 por fatura, não a importação; o gasto não carrega `pagador`). Lançamentos importados recebem `origem: 'fatura'`. O card "💳 Cartão de Crédito" na aba Config guarda apenas o fechamento/vencimento *padrão* (fallback para gastos sem `cardId`) e o botão "🔄 Recalcular competências" (`recalcularCompetencias()`).

---

## Aprendizado de Classificação (`merchantMap`)

Corrige e memoriza descrições de fatura que a classificação por palavra-chave erra sistematicamente (ex: `"IFD*MOKKA FLORIPA"` → "iFood" / Alimentação).

- Chave: descrição original exata, ou prefixo com `*` no final (ex: `IFD*`) para casar por `startsWith`
- `_merchantLookup(desc)` — busca exata primeiro, depois prefixos com `*`
- `_merchantLearn(origKey, newDesc, newCatId, newCatNome)` — incrementa `vezesCorrigido`; ao atingir **3 correções**, liga `autoAplicar = true` automaticamente
- Cadastro manual: aba Categorias → card de aprendizado → `saveMerchantMapping()` (já cria com `autoAplicar: true` direto)
- Com `autoAplicar` ligado, a próxima importação de fatura já chega com a descrição/categoria corrigidas (`t.autoApplied = true`, badge `🤖 auto`); sem isso, aparece só como sugestão (`t.suggested`)

**Validado (12/07/2026)** exercitando as funções reais: 1ª e 2ª correção da mesma descrição → aparece como **sugestão** (`suggested`); na **3ª** correção `autoAplicar` liga e a importação seguinte **auto-aplica** a correção (`autoApplied`, descrição já substituída). Chave com prefixo `*` casa por `startsWith` corretamente. Comportamento conforme o planejado.

---

## Metas Mensais e Gráfico de Evolução

`monthGoals[]`: `{ month ('YYYY-MM'), teto, renda }` — uma entrada por mês, gerenciada na aba Orçamento (card "🎯 Meta do mês"). `saveMonthGoal()` substitui a entrada do mês atual; `copyGoalFromPrevMonth()` clona a meta do mês anterior; `deleteMonthGoal()` remove. `renderMonthGoal()` mostra barra de progresso do gasto atual contra o teto e a linha "💰 Economia projetada" (projeção baseada no ritmo atual de gastos vs. `renda`).

O gráfico de evolução (`renderEvolutionChart()` + `renderEvolutionSummary()`, Dashboard) usa Chart.js 4.4.1 (auto-hospedado em `src/vendor/chart.umd.js`) — linha dos últimos 6 meses com `borderDash: [6, 4]` marcando o teto da meta (`spanGaps: true` para meses sem meta). O resumo mostra "Mês atual vs anterior: ±X% (R$ valor)".

---

## Saldo Anual Acumulado e Acertos de Conta (`acertos`)

**A Divisão considera SOMENTE gastos compartilhados (`pessoa === coupleName`).** Gastos pessoais (`pessoa === p1Name`/`p2Name`, de cartões pessoais como 5058/9161 ou lançamentos manuais pessoais) são 100% responsabilidade da própria pessoa e **nunca** entram no acerto entre o casal.

### Divisão por fatura (`faturaPagamentos[]`)
**Quem paga a fatura do cartão do Casal varia mês a mês** — não é propriedade fixa do cartão. Cada fatura (cartão de crédito com `dono === coupleName`, agrupada por `mesCompetencia`) tem um registro em `faturaPagamentos[]`: `{ cardId, mesCompetencia ('YYYY-MM'), formaPagamento: 'dividido'|'p1'|'p2'|'personalizado', valorGabriel, valorAnna, pago, dataPagamento, contexto }`. **Ausência de registro = `dividido`** (default → sem dívida).
- `_faturaSplit(cardId, mes, total)` resolve quanto cada um pagou daquela fatura: `dividido`/`p1`/`p2` recalculam do total vigente; `personalizado` usa os valores salvos.
- **Arredondamento em centavos inteiros (sem fantasma de R$ 0,01):** `_monthCouplePaid` e `_calcAnnualBalance` somam tudo em **centavos inteiros** (`Math.round(v*100)`), nunca em float acumulado — o `reduce` de `e.valor` em float dava ruído (ex: `1300.00` virava `1300.0000000002`), que a subtração `p1Paid − p2Paid` transformava num centavo fantasma acumulando mês a mês. Além disso, **`dividido` é 50/50 exato que NÃO gera dívida**: soma metades idênticas (`totalC/2`) aos dois lados, então diff = 0 mesmo com total de centavo ímpar (elimina o viés antigo em que `valorAnna = total − half` mandava o centavo extra sempre para o mesmo lado). Só `p1`/`p2`/`personalizado` (e `pagoPor` manual) geram dívida real. Regressão validada com os dados reais: meses com valores iguais (650/650, 705/705, e Fev 2341,63/2341,63) dão diff **0,00**, não 0,01.
- `_monthCouplePaid(sharedExp, mes)` agrupa os gastos Casal do mês em faturas (cartão do Casal) + gastos manuais (não-fatura) e soma `p1Paid`/`p2Paid`. A dívida é `|p1Paid − p2Paid| / 2`. Retorna também `manualP1`/`manualP2`/`manualSplit` (breakdown dos manuais). Faturas → `_faturaSplit`; **gastos manuais** → ver "Pagador de gasto manual" abaixo.
- `_calcAnnualBalance()` e `renderDivisao()` usam `_monthCouplePaid()` — não há mais `_expensePagador`/`_cardPagador`.
- **UI (aba Divisão, card "💳 Faturas do Casal"):** `renderFaturasDivisao()` mostra um card por fatura do Casal do mês com seletor de forma (`setFaturaForma()`), campos de valor no modo personalizado (`saveFaturaPersonalizado()`) e "Marcar como paga" (`toggleFaturaPago()`). Cada mudança grava em `faturaPagamentos` + `saveAll()` + re-render.

#### Pagador de gasto manual do Casal (`expense.pagoPor`)
Complementa o modelo de fatura para o ponto 5 da divisão: um gasto do Casal **que não é fatura de cartão de crédito do Casal** (Pix/Dinheiro/Débito, ou crédito num cartão não-Casal) pode ter sido adiantado por uma pessoa só. `_isManualCoupleExpense(e)` identifica esse caso (`pessoa === coupleName && !(metodo==='Crédito' && cardId ∈ cartões do Casal)`). Esse gasto carrega `e.pagoPor` (`p1Name` | `p2Name` | `'' `=dividido).
- Em `_monthCouplePaid`, cada manual com `pagoPor === p1`/`p2` conta **100%** para essa pessoa; sem `pagoPor` é dividido (metade cada → sem dívida). Flui automaticamente para o saldo mensal e anual (ponto 5 completo).
- **UI:** seletor `#edit-pagopor` no modal de edição (`#edit-pagopor-wrap`), populado/mostrado por `_updateEditPagoPor(preselect)` — só aparece quando o gasto é manual do Casal (reavaliado nos `onchange` de pessoa/método/cartão). `saveEdit()` grava `exp.pagoPor` (ou faz `delete` quando não é manual do Casal). Badge `💸 <nome> adiantou` em `expenseItemHTML()`.
- **Persistência:** `faturaPagamentos` está em todos os pontos de save/load/backup/migrateData/restore/snapshot. Chave web: `gc_faturapag`.
- **Migração:** faturas já existentes ficam sem registro → `dividido` (zera a dívida acumulada anterior, que no modelo errado vinha do `pagador` fixo do cartão 1256). O usuário ajusta manualmente as que uma pessoa pagou sozinha.

Card "📊 Saldo anual acumulado" na aba Divisão, acima do card mensal existente. `_calcAnnualBalance(year)` é uma função pura que recalcula, mês a mês, `runningBalance += (p1Paid - p2Paid)` — com `p1Paid`/`p2Paid` = gastos **Casal** adiantados por cada pessoa (ver acima) — e aplica os acertos do mês (`de === p2 → runningBalance -= valor`; `de === p1 → runningBalance += valor`), retornando `{ rows, annualP1, annualP2, finalBalance }`. Positivo = p1 está a receber; negativo = p2 está a receber.

`acertos[]`: `{ id, de, para, valor, data (DD/MM/YYYY), nota, contexto, criadoEm }` — um registro de Pix que "zera" o saldo até aquele ponto. Fluxo: `openAcertoModal()` pré-calcula a direção e o valor (`Math.abs(finalBalance) / 2`) → `confirmarAcerto()` grava em `acertos[]` e chama `saveAll()` → `deleteAcerto(id)` remove. Navegação de ano via `navAnnualYear(±1)`, estado em `_annualYear` (não persistido — sempre reinicia no ano de `currentMonth`).

---

## Filtros Avançados e Ordenação (Lançamentos)

Estado em `_listFilters` (pessoa, dateFrom, dateTo, valorMin, valorMax, metodo, cardId, origem — todos combinados em AND) e `_listSort` (`field: 'data'|'valor'|'categoria'`, `dir: 'asc'|'desc'`), ambos não persistidos. `renderList()` aplica busca full-text + filtro de categoria (pills, `activeFilter`) + `_listFilters` + `_listSort`, nessa ordem, sobre `contextMonthExpenses()`.

- `toggleAdvancedFilters()` abre/fecha o painel `#advanced-filters` (`_advFiltersOpen`)
- `_handleFilterPillClick()` alterna pills de pessoa/método/origem (clique de novo desmarca)
- `_setListSort(field)` alterna direção se clicar no mesmo campo já ativo
- `clearAllListFilters()` reseta filtros, ordenação **não muda**; `clearFilters()` é apenas um alias legado
- `_renderFilterSummary()` mostra a barra "N de M itens" com resumo dos filtros ativos
- **Layout responsivo:** `#advanced-filters` usa `grid-template-columns:repeat(auto-fit,minmax(190px,1fr))` — as colunas preenchem toda a largura e refluem sozinhas ao redimensionar (6 colunas em tela larga → 3 → 2 → 1). **Use `auto-fit`, não `auto-fill`** (este último deixa colunas-fantasma vazias à direita). Os dois campos `type="date"` (De/Até) ficam **empilhados** (`flex-direction:column`) para caber a data completa `DD/MM/YYYY` + o ícone do calendário.

---

## Backup e Restauração

Card "Backup" na aba Config, com três botões: **⬇️ Exportar backup** (sem senha), **🔒 Exportar com senha** (`exportBackupEncrypted()`) e **⬆️ Restaurar backup**. `buildBackupPayload()` (função pura, testável) monta o *payload*: `_version`, `appVersion: '2.0'`, `backupDate`, todo o estado (`expenses`, `customCats`, `budgets`, `fixedExpenses`, `cards`, `monthGoals`, `merchantMap`, `acertos`, `deletedIds`) e `config` — **uma cópia de `appConfig` com as `SECRET_CONFIG_KEYS` removidas** (`tgToken`, `tgTokenEnc`, `sheetsSecret`, `sheetsSecretEnc`, `appsScriptUrl`). O backup **nunca contém credenciais** — ver "Armazenamento de segredos" na Segurança. Um aviso no card informa que o backup contém dados financeiros legíveis e deve ser guardado com cuidado.

### Formato do arquivo (formato 2 — wrapper com integridade)
`_buildBackupFile(password)` embrulha o payload num wrapper `{ _finannza:'backup', _format:2, appVersion, backupDate, encrypted, checksum, ... }`:
- **Sem senha:** `encrypted:false`, `payload` como objeto (legível), `checksum` = SHA-256 do `JSON.stringify(payload)`.
- **Com senha:** `encrypted:true` + `cipher:'aes-256-gcm'`, `kdf:'scrypt'`, `salt`/`iv`/`authTag` (hex) e `data` (base64) — o payload em texto puro **não** aparece no arquivo. `checksum` é do payload em claro (verificado após descriptografar).

Cripto no **main process** (Node `crypto`), exposta via IPC (`preload.js` → `window.electronAPI.backupSeal/backupOpen`):
- `backup-seal(plaintext, password)` — calcula o SHA-256; se houver senha, deriva a chave AES-256 via `scryptSync(password, salt)` e cifra com AES-256-GCM (salt/iv aleatórios por backup).
- `backup-open(bundle, password)` — descriptografa (GCM autentica: senha errada **ou** ciphertext adulterado → falha) e devolve `{ ok, value, checksumOk }`. Para bundle não-criptografado, o renderer passa `payloadStr` e só o checksum é conferido.

### Importação e restauração
`importBackup()` → `_handleImportContent()` detecta o formato: wrapper criptografado → abre o **modal de senha** (`#backup-pass-modal`, `_openBackupPassModal('import')` → `_decryptAndProcess()`); wrapper não-criptografado → `_verifyAndProcess()` (confere o checksum, **avisa e pede confirmação** se a integridade falhar); payload cru legado (backups ≤ v1.1.9) → direto. Todos caem em `_processImport(payload)` → resumo + confirmação → `executeRestore()`:
1. **Snapshot de segurança rotacionado** — `_rotatePreRestore()` mantém as **3 versões mais recentes** (`gastos-pre-restore-1.json` = mais nova … `-3` = mais antiga; desloca 2→3, 1→2, grava a nova em 1) **antes** de sobrescrever qualquer coisa. Usa só `readFile`/`writeFile`/`fileExists` (sem listar diretório).
2. `migrateData(data)` normaliza/coage tipos (`asArray`/`asObject`).
3. Restaura todos os arrays de estado + `merchantMap`/`acertos`.
4. **Nunca** sobrescreve `appConfig.dataFolderPath` nem as credenciais — preservados via `keepLocal`. Após restaurar, `hydrateSecrets()` re-hidrata os segredos em memória.

O modal de senha (`_openBackupPassModal(mode)`/`_confirmBackupPass()`/`_closeBackupPassModal()`) serve tanto export (dois campos: senha + confirmação, mín. 4 chars) quanto import (só senha). **A senha não é recuperável** — se o usuário esquecer, o backup criptografado é irrecuperável (avisado no hint).

### Snapshots automáticos (complementa — não substitui — o backup manual)
A cada `saveAll()` (Electron), no **máx. 1×/dia**, grava uma cópia em `<pastaDeDados>/gastos-backups/gastos-AAAA-MM-DD-HHhMM.json` — **mesmo formato 2** do backup manual (wrapper com checksum, sem senha, sem credenciais). Funções (topo do `renderer.js`):
- `_autoSnapshot()` — chamado por `saveAll()` (fire-and-forget). Gate 1×/dia via `appConfig.lastAutoSnapshot` (`'YYYY-MM-DD'`), **setado antes** do trabalho assíncrono para evitar corrida entre saves seguidos. Reusa `_buildBackupFile('')`.
- `_pruneOldSnapshots(dir)` — apaga snapshots com mais de `SNAPSHOT_RETENTION_DAYS` (30) dias (data lida do nome). Usa os IPC novos `list-dir`/`delete-file` (`window.electronAPI.listDir/deleteFile`).
- `_snapshotBeforeMigration(motivo)` — cria um snapshot **imediato** (ignora o gate) antes de operações que trocam o local dos dados; chamado em `changeDataFolder()` (nome `gastos-pre-troca-de-pasta-...`). Hook para futura migração de legado (`.legacy-import-checked`).
- **UI (Config, card "🗂️ Snapshots automáticos"):** `renderAutoBackups()` lista os snapshots (data + nº de lançamentos, lido de cada arquivo) com botão **Restaurar** → `_restoreSnapshot(nome)` → `_handleImportContent()` (reusa o fluxo: **preview** + verificação de checksum + snapshot pré-restauração rotacionado). Chamado em `switchTab('config')`.

O backup manual (com/sem senha) segue idêntico e independente — o automático é uma rede de segurança adicional, local, na pasta de dados.

---

## Estrutura das Abas

### Header (`.header`, fora das abas)
```
.header-brand → .header-title "FIN[ANN dourado #C9A24B]ZA" — sem logo, sem slogan
.header-right → ctx-toggle (Pessoal/Empresa) · select #month-sel · theme-btn  (botão/badge do bot removidos)
```
Sem `<img>` de logo (removido — nome estilizado é a identidade visual) e sem subtítulo. Borda inferior `2px solid #B8913A` separando do `.tabs`. `select.month` tem `width:auto;flex-shrink:0` explícito — sem isso, a regra global `input,...,select{width:100%}` (index.html) faz o select ocupar 100% do `.header-right` e quebra os outros controles em linhas.

Badge de versão discreto (`#app-version-badge`, `position:fixed` canto inferior **esquerdo**) populado por `renderAppVersionInfo()` via IPC — ver seção "Auto-Update" abaixo. Fica à esquerda de propósito: `.content` tem `overflow-y:auto` e a scrollbar nativa ocupa o canto inferior direito da janela — um badge fixo ali sobrepõe a barra de rolagem em telas com conteúdo longo.

### Dashboard (`panel-dashboard`)
```
.metrics (grid 4 cols)
  #m-total      — Total do mês (soma de contextMonthExpenses)
  #m-count      — Nº de lançamentos
  #m-maior      — Maior gasto (valor + descrição)
  #m-cat        — Categoria com maior gasto
  #m-media      — Média por lançamento
#budget-alerts  — Alertas de orçamento
grid 2 cols:
  card "Por categoria" → canvas #chart-cat + #chart-legend
  card "Por pessoa"    → canvas #chart-person
card "Últimos lançamentos" → #recent-list (últimos 5)
```

### Registrar gasto (`#add-modal` — modal global, não é mais uma aba)
```
form-row cols2: [pills #person-pills] [select #add-method]
textarea #add-msg (texto livre → auto-classifica)
checkbox #chk-installment → #installment-fields (cols3: parcelas/atual/total)
checkbox #chk-shared     → #shared-fields (cols2: % p1 / % p2)
#add-preview (pré-visualização, oculto)
#add-loading (barra de progresso)
#add-error
btn-row: [Limpar] [👁 Pré-visualizar] [✚ Adicionar]
<details> "Testar classificador" — input #test-input + button + #test-result
```
Aberto via `openAddModal()` (botão "✚ Novo lançamento" na aba Lançamentos).

### Lançamentos (`panel-lancamentos`)
```
header: "Lançamentos" + #list-count
  sort buttons #sort-data / #sort-valor / #sort-categoria
  toggle #adv-filter-toggle → #advanced-filters (pills pessoa/método/origem, datas, valor min/max, #filter-card-sel)
  btn 🧹 Duplicatas (limparDuplicatasFatura) · btn 📄 Importar fatura (openInvoiceImport) · btn ✚ Novo lançamento (openAddModal)
card filtros: input #search-input + #cat-filters (pills) + #filter-summary + btn Limpar → clearAllListFilters()
.expense-list #all-list (renderList())
```
`✚ Novo lançamento` abre o `#add-modal` (registro de gasto — texto livre, pessoa, método, parcelas, divisão) e `📄 Importar fatura` abre `#invoice-modal` (pré-visualização da fatura importada) — ambos são modais globais, não abas/painéis próprios.

### Orçamento (`panel-orcamento`)
```
card "🎯 Meta do mês" — #goal-month-label, input teto/renda, barra de progresso, "Economia projetada"
  btns: copiar do mês anterior (copyGoalFromPrevMonth), salvar (saveMonthGoal), remover (deleteMonthGoal)
card(s) de orçamento por categoria (budgets[])
```

### Divisão (`panel-divisao`)
```
card "📊 Saldo anual acumulado" — nav ◀/▶ ano (#annual-balance-year), #annual-balance (tabela mês a mês)
card "Acerto de contas do mês" (#balance-summary) — saldo do mês corrente + btn "Registrar acerto" → #acerto-modal
card de parcelas/divisão detalhada (renderDivisao())
```

### Config (`panel-config`)
```
card "💳 Meus cartões" — #cards-list (renderCardsList()), form de cadastro/edição de cartão
card "💳 Cartão de Crédito" — #cfg-fechamento/#cfg-vencimento (padrão/fallback) + btn 🔄 Recalcular competências
card "🗄️ Backup" — #backup-info + exportar (exportBackup/exportBackupEncrypted) / importar (importBackup)
card "🗂️ Snapshots automáticos" — #auto-backups-list (renderAutoBackups()) + restaurar (_restoreSnapshot)
card "ℹ️ Sobre" — versão + data da última build (lidas via IPC, ver "Auto-Update") + btn 🔄 Verificar atualizações
```

### Categorias (`panel-categorias`)
```
card "Nova categoria"
  form-row cols3:
    input #new-cat-name (text)
    input #new-cat-icon (text, maxlength=2, font-size:18px) ← campo simples, sem picker visual
    #color-picker (11 divs .color-opt com data-color)
  input #new-cat-words (palavras-chave, separadas por vírgula)
  btn [✚ Criar categoria]
.cat-grid #cat-grid (renderCatGrid())
card "Aprendizado de classificação" — #merchant-form-key/nome/cat, lista de mapeamentos (renderMerchantMap()), toggle auto-aplicar, excluir
```

**Ícone emoji:** é um `<input type="text" maxlength="2">` simples. Fallback para `📦` se vazio. Atenção: `maxlength="2"` pode truncar emojis compostos (família, bandeiras) — limitação conhecida.

---

## Design System (CSS Variables)

**Tipografia:** corpo em **Inter** (`'Inter','Segoe UI',system-ui,...`), **14px** base, `font-weight:500`, `font-variant-numeric:tabular-nums` (dígitos alinham em colunas). Números de destaque (cards `.metric-value`) em **IBM Plex Mono** (visual de extrato bancário). Ambas auto-hospedadas em `vendor/fonts/` (Inter 400/500/600/700, IBM Plex Mono 500/600 — subset latin). Hierarquia de peso: corpo 500, `.expense-desc`/labels 600, valores/`.expense-amount`/títulos 600–700. **Nunca usar peso < 400** (piso; body é 500). 13px/11px só para labels/legendas secundárias.

| Variável | Light | Dark | Uso |
|---|---|---|---|
| `--bg` | `#EEE9E1` | `#18242F` | fundo geral |
| `--surface` | `#FFFFFF` | `#1F2F3D` | cards, header |
| `--border` | `#DDDBD3` | `#2C4157` | bordas |
| `--text` | `#1A2530` | `#EDE9DE` | texto principal |
| `--muted` | `#8A8680` | `#7A9AB5` | labels, subtítulos |
| `--faint` | `#F5F1EC` | `#1A2B3A` | fundos suaves |
| `--danger` | `#8B2E2E` | `#C97070` | erros |
| `--success` | `#235C3F` | `#5BAA7D` | confirmações |
| `--warn` | `#7A5818` | `#C8A060` | alertas |
| `--accent` | `#344B62` | `#7EAACB` | botões primários, tab ativa |
| `--blue` | `#2E5480` | `#7EAACB` | links, badges |
| `--pink` | `#7A3F5E` | `#C47EA0` | badges pessoa 2 |
| `--green` | `#235C3F` | `#5BAA7D` | badges positivos |

Tema alternado por `toggleTheme()` via atributo `data-theme="dark"` no `<html>`.

---

## Padrões de Código

**Datas:**
- Storage (`expenses[].data`): `'DD/MM/YYYY'` (pt-BR)
- Inputs `type="date"` e comparações: ISO `'YYYY-MM-DD'`
- Conversão: use `parseDateStr()` — nunca converta manualmente

**IDs:** `Date.now() + Math.random()` → `float`. Busca: `expenses.find(e => e.id === id)`.

**Moeda:** sempre `fmt(valor)` — nunca `toLocaleString` espalhado.

**Notificações:** `notify(msg, tipo)` onde tipo ∈ `{'ok', 'err', 'info', 'warn'}`.

**HTML seguro:** sempre `escapeHtml(str)` em dados do usuário dentro de template literals com `innerHTML`. A função já existe no renderer.

**Classificação:** use `classifyInput(text)` (injeta `customCats`), nunca `classify(text)` diretamente.

**Render functions:** são idempotentes — chamá-las múltiplas vezes só re-renderiza, sem side effects.

---

## Como Adicionar uma Nova Aba/Feature

1. **HTML** (`index.html`): `<div class="tab" data-tab="nome">` na `.tabs` + `<div class="panel" id="panel-nome">` no `.content`
2. **Lógica** (`renderer.js`): adicione caso em `switchTab()`:
   ```js
   if (name === 'nome') renderMinhaFeature();
   ```
3. **Render function:** lê de `expenses`/`budgets`/`customCats`, constrói HTML como string, atribui a `element.innerHTML`
4. **Estado persistido:** se precisar de novo campo, adicione ao objeto em `saveAll()` e restaure em `loadAll()`

---

## Dívida Técnica Conhecida (Não Introduza Mais)

### Críticas (segurança)
- Token do Telegram exposto na URL de fetch para a API do Telegram (`api.telegram.org/bot<token>/...`) — inerente à API. Mitigado: nunca é logado em texto puro (ver `scrubSecrets()`), e o bot interno fica desativado. O log automático de rede do Chromium (DevTools) ainda pode mostrá-lo se o bot interno for ligado.

### Funcionais
- **Nomes hardcoded** ("Eu", "Anna", "Casal") em partes do `index.html` (header, ctx buttons) — os nomes configuráveis já funcionam via `appConfig`, mas o HTML inicial ainda tem strings fixas.
- **Cálculo de divisão** assume exatamente 2 pessoas. `renderDivisao()` funciona só para o par p1/p2.
- **Cor aleatória por render** para pessoas desconhecidas: `Math.random()` em `renderCharts()` — muda a cada refresh.
- **Agrupamento de parcelas por `e.descricao`** em `renderDivisao()` — colide se duas despesas tiverem nome idêntico.
- **`deletedIds` não persiste no modo web** (localStorage) — só é salvo no `gastos.json` do Electron.

### Resolvidos nesta sessão
- ~~Seletor de meses hardcoded para 2026~~ — agora gerado dinamicamente em `buildMonthSelector()`
- ~~`currentMonth` inicializado como `'2026-05'`~~ — agora `new Date().toISOString().slice(0,7)`
- ~~Bot interno auto-iniciava na abertura~~ — removido; bot externo no Render é o único autorizado
- ~~Mutação silenciosa de `DEFAULT_CATEGORIES`~~ — corrigido com deep copy em `classify()`
- ~~Dupla contagem de variantes normalizadas~~ — corrigido com `seen` Set no loop de scoring
- ~~`'anel'` em roupas capturava "janela" erroneamente~~ — removido de `roupas` no `bot.js` (`"janela"` contém `"anel"` como substring, marcava 2 pts para roupas)
- ~~"janela" e termos de reforma/esquadria não classificavam como Moradia~~ — adicionadas 23 palavras à categoria `moradia` no `bot.js`: janela, vidro, vidraçaria, esquadria, persiana, veneziana, mosquiteiro, grade, tela mosquiteiro, calha, impermeabilização, infiltração, goteira, rejunte, silicone, porta, dobradiça, fechadura, maçaneta, trinco, parafuso, bucha, ferrolho
- ~~`nodeIntegration: true` + `contextIsolation: false` + `webSecurity: false`~~ — `main.js` já usa `nodeIntegration: false` + `contextIsolation: true` + `preload.js` com `contextBridge` (`window.electronAPI`)
- ~~Header com logo cortado e nome pequeno~~ — logo removido, "FINANNZA" em destaque (28px, "ANN" dourado), borda inferior dourada, controles alinhados em uma linha
- ~~`select.month` sem `width:auto` explícito~~ — herdava `width:100%` de uma regra CSS global de `select`, quebrando os controles do header em múltiplas linhas
- ~~"Verificar atualizações" não dava feedback nenhum~~ — dialogs adicionados para modo dev / já atualizado / erro (só quando a checagem é manual)
- ~~Releases do GitHub ficavam presos como draft~~ — `releaseType: "release"` adicionado ao `build.publish`; v1.0.0/v1.1.0/v1.1.1 tiveram que ser publicados manualmente via API para corrigir o histórico
- ~~`quitAndInstall()` travava com "Não é possível fechar o Finannza"~~ — flag `isQuitting` faz o handler de `close` parar de interceptar e minimizar para bandeja durante o auto-update/sair
- ~~Auto-update reabria o wizard completo do instalador (per-user/all-users)~~ — `quitAndInstall(false, true)` estava com `isSilent=false`, rodando o NSIS 100% interativo; corrigido para `quitAndInstall(true, true)` (`isSilent=true` → flag `/S`, pula todas as páginas independente de `oneClick`)
- ~~Versão do app não aparecia em lugar nenhum na UI~~ — badge discreto no canto da tela + card "Sobre" na Config, ambos lidos via IPC (`getAppVersion()`/`getBuildDate()`)
- ~~Badge de versão sobrepunha a scrollbar~~ — estava fixo no canto inferior direito, mesmo canto onde a scrollbar nativa de `.content` aparece em telas com conteúdo longo; movido para o canto inferior esquerdo
- ~~`sandbox` não era explícito em `webPreferences`~~ — adicionado `sandbox: true` (era o default do Electron ≥20, agora blindado contra regressão); preload em `contextBridge` funciona em sandbox, nada quebrou
- ~~Dependências carregadas por CDN (cdnjs, Google Fonts)~~ — Chart.js, SheetJS e a fonte Manrope auto-hospedados em `src/vendor/`; app agora funciona offline e sem risco de supply-chain
- ~~Ausência total de CSP~~ — CSP restritiva aplicada via `onHeadersReceived` (Etapa 2B, com `'unsafe-inline'` temporário para script/style); `connect-src` libera Telegram + Apps Script (incl. o host de redirect `script.googleusercontent.com`). Falta ainda a Etapa 2A (remover `'unsafe-inline'` refatorando os `onclick`/`style` inline)
- ~~Token/secret salvos em texto puro no `localStorage`~~ — migrados para `safeStorage` (cifrados em base64; texto puro só em memória). Migração automática de versões antigas + fallback gracioso se cripto indisponível
- ~~Backup exportado vazava token/secret em texto puro~~ — `buildBackupPayload()` remove todas as `SECRET_CONFIG_KEYS`; aviso na UI de que credenciais não são incluídas
- ~~Logs podiam expor o token completo~~ — `scrubSecrets()`/`maskToken()` mascaram token e secret em `addLog()` e `console.error` (ex. `123456:***`)
- ~~`.gitignore` não cobria os backups reais (`finannza-backup-*.json`) nem `.env`~~ — adicionados ao `.gitignore` principal; repo do bot ganhou `.gitignore` (`.env`, `.env.*`, `node_modules/`, exceção `!.env.example`) e um `.env.example` documentando as chaves

---

## Segurança

> Visão consolidada (arquitetura, armazenamento de credenciais, modelo de ameaça, resposta a incidentes e checklist) em [`SECURITY.md`](SECURITY.md) na raiz. Esta seção guarda os detalhes de implementação por função.

### Electron hardening (`main.js`) — já implementado
```js
webPreferences: {
  nodeIntegration: false, contextIsolation: true, sandbox: true,
  preload: path.join(__dirname, 'preload.js'),
}
```
Toda comunicação com o processo principal passa por `preload.js` (`contextBridge.exposeInMainWorld('electronAPI', ...)`). Não reintroduza `nodeIntegration: true` nem `contextIsolation: false`, e não desative o `sandbox`. O `sandbox: true` já era o default do Electron ≥20 quando `nodeIntegration:false` — foi tornado **explícito** para blindar contra regressão. O `preload.js` usa só `contextBridge` + `ipcRenderer`, ambos permitidos em preload sandboxed, então nada quebra.

### Allowlist de caminhos nos IPC de arquivo (`main.js`)
Defesa em profundidade: os IPC `read-file`/`write-file`/`delete-file`/`list-dir`/`file-exists` só operam em caminhos permitidos — um XSS teórico no renderer não consegue ler/escrever arquivos arbitrários do sistema. `_isPathAllowed(target)` (usa `path.resolve` + checagem de prefixo, bloqueia traversal) libera:
- **`_allowedRoots`** (diretórios, recursivo): `app.getPath('userData')` (sempre, registrado no `whenReady`); a pasta de dados customizada persistida, registrada pelo renderer no `init()` via IPC `register-data-folder` (`window.electronAPI.registerDataFolder(appConfig.dataFolderPath)`); e qualquer pasta escolhida pelo usuário via `select-folder`.
- **`_allowedFiles`** (arquivos exatos): os caminhos retornados por `save-file-dialog`/`open-file-dialog` — como vêm de um diálogo nativo, o renderer não consegue forjá-los.
- Fora disso: `read`→`null`, `write`/`delete`→`false`, `list`→`[]`, com `console.warn` discreto. **Ao adicionar um novo caminho que o app precise ler/escrever, garanta que ele caia sob uma raiz permitida** (ou registre a pasta), senão a operação será bloqueada.

### Guardas de navegação (`createWindow`)
`win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))` nega abertura de novas janelas e `win.on('will-navigate')` bloqueia navegar para fora da URL local (`file://.../index.html`). O app é 100% local e nunca faz nenhum dos dois — isso limita o alcance de um renderer comprometido (sem popup, sem redirect para site externo).

### Content Security Policy (CSP)
Aplicada a **todas** as respostas via `session.defaultSession.webRequest.onHeadersReceived` no `main.js` (função `applyCsp()`, chamada em `app.whenReady()` **antes** de `createWindow()`). Confirmado que o `onHeadersReceived` dispara para o protocolo `file://` neste Electron (29) — o header chega em cada resposta (documento, scripts do vendor, fontes). Política atual (constante `CSP_POLICY`):
```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'self' https://api.telegram.org https://script.google.com https://script.googleusercontent.com;
object-src 'none';
base-uri 'none'
```
- **`'unsafe-inline'` em `script-src`/`style-src` é temporário (Etapa 2B pragmática).** O HTML tem um `<script>` inline (bloco de tema) e ~60+ atributos `onclick=`/dezenas de `style=` inline. Removê-los exige refatorar tudo para `addEventListener`/classes (Etapa 2A, ainda pendente). Sem `'unsafe-inline'`, todos os `onclick` e o CSS inline quebram. Chart.js 4 e SheetJS **não** precisam de `'unsafe-eval'` (verificado exercitando todos os fluxos sob a CSP — zero violações).
- **`connect-src` lista só as origens que o renderer chama via `fetch`:** `api.telegram.org` (bot interno — `getUpdates`/`sendMessage`/`getMe`), `script.google.com` (Apps Script `syncFromSheets`) e `script.googleusercontent.com` (**destino do redirect 302** do Apps Script — sem ele o sync quebra na etapa do redirect). Ao adicionar qualquer nova chamada `fetch` para host externo, **adicione o host aqui** ou a requisição será bloqueada.
- **Cuidado ao testar CSP batendo na raiz de um host** (`https://api.telegram.org/`, `https://script.google.com/`): essas raízes respondem 302 redirecionando para **outra** origem não-allowlistada (telegram.org, google.com), e o Chromium reporta a violação do redirect contra a **URL original**, dando falso-positivo de "host allowlistado bloqueado". As chamadas reais do app (path completo, ex. `/bot<token>/getUpdates` ou `.../exec`) não têm esse redirect cross-origin e passam normalmente — confirmado com `fetch('https://api.telegram.org/bot000000:invalid/getMe')` retornando HTTP 401 (resposta do próprio Telegram) sem violação de CSP.

### Dependências de terceiros — auto-hospedadas (`src/vendor/`)
Chart.js 4.4.1 (`vendor/chart.umd.js`), SheetJS/xlsx 0.18.5 (`vendor/xlsx.full.min.js`) e as fontes **Inter** (`vendor/fonts/inter-latin-{400,500,600,700}-normal.woff2`) e **IBM Plex Mono** (`vendor/fonts/ibm-plex-mono-latin-{500,600}-normal.woff2`), subset latin — cobre acentuação pt-BR, são servidos **localmente**, não mais por CDN (cdnjs/Google Fonts). (A fonte anterior, Manrope, foi substituída por Inter por legibilidade — ver Design System.) Isso: (a) permite a CSP com `default-src 'self'`/`script-src 'self'`; (b) elimina risco de supply-chain do CDN; (c) faz o app funcionar **offline**, alinhado à filosofia "100% local". `package.json → build.files` já inclui `src/**/*`, então o `vendor/` entra no instalador automaticamente. Ao atualizar uma dessas libs, **rebaixe o arquivo para `vendor/` e ajuste a tag `<script>`** — nunca volte a apontar para CDN.

### Prioridade 1 — Sanitização de HTML (XSS)
`escapeHtml()` (escapa `& < > " '`) é aplicado em **100%** dos pontos de `innerHTML` que recebem dado externo — auditado campo a campo: `descricao`/`categoria`/`pessoa`/`data`/`metodo` em `expenseItemHTML()`, relatórios, divisão, parcelas, faturas; `desc`/`origDesc`/`catBanco`/`parcela` no preview de fatura (`_renderInvoicePreview`); nomes de merchant e de cartão. `icone`/`cor` vêm de definições internas de categoria (não de texto externo). **Não há lacuna de XSS** — dados do Telegram/Sheets/fatura são armazenados crus mas escapados na renderização (um `<img onerror>` numa descrição aparece como texto literal, não executa). Ao adicionar novo template literal com dado do usuário, sempre passe por `escapeHtml()`.

### Validação e sanitização de dados externos (ingestão)
Complementa o `escapeHtml()` (que protege o DOM): impede que dados malformados/maliciosos de fontes externas (sync do Sheets, bot do Telegram, importação de fatura) quebrem o app. Helpers no topo do `renderer.js` (constante `VALIDATION` com os limites):
- `sanitizeText(s, max)` — remove caracteres de controle (`\x00-\x1F\x7F`), colapsa espaços, trunca. Limites: descrição 200, mensagem 1000, nome 80, categoria 80.
- `sanitizeMoney(v)` — retorna número em `0..1.000.000` (2 casas) ou **`null`** se inválido/fora da faixa (NaN, negativo, absurdo).
- `sanitizeDateBR(d)` — valida `DD/MM/YYYY` real (ano `2000..2100`, rejeita `31/02`) ou `null`.
- `asArray(v)`/`asObject(v)` — coerção defensiva para JSON parseável mas com tipo errado.

Onde é aplicado:
- **`syncFromSheets()`** — `Array.isArray(data.gastos)`; por registro: valor inválido → **descarta** (conta em `dropped`, `console.warn` discreto sem expor dados); data inválida → cai para hoje; strings truncadas. Registro sem `id` ou não-objeto → descartado.
- **`addExpenseObj()`** (entrada manual + bot) — valor inválido/fora da faixa → `notify` de erro e **não adiciona**; descrição/categoria/pessoa/mensagem sanitizadas.
- **`pollTelegram()`** — `Array.isArray(data.result)`, guarda `msg.chat`; `from`/`text` sanitizados (cap de tamanho antes de `classifyInput`).
- **`handleInvoiceFile()`** — valida presença das colunas `Descrição`/`Valor (em R$)` (erro claro se ausentes: "Formato de arquivo inesperado… fatura C6 Bank"), `Array.isArray(rows[1])`; por linha valor/descrição/data sanitizados, linhas inválidas contadas e logadas.
- **`loadAll()` / `migrateData()`** — cada array/objeto do JSON passa por `asArray`/`asObject`, então um `gastos.json`/backup corrompido-mas-parseável (ex: `expenses:"x"`) não injeta estado inválido. `JSON.parse` sempre em try/catch; `importBackup()` valida `Array.isArray(data.expenses)` antes de aplicar e grava snapshot `gastos-pre-restore.json` antes de sobrescrever.

### Armazenamento de segredos — `safeStorage` (implementado)
`tgToken` e `sheetsSecret` são criptografados com **`safeStorage` do Electron** (DPAPI no Windows, atrelado à conta do SO) antes de irem para o `localStorage`. O `localStorage['gc_config']` guarda só as versões cifradas em base64 (`tgTokenEnc`/`sheetsSecretEnc`) — **nunca o texto puro**. O texto puro existe só em memória (`appConfig.tgToken`/`sheetsSecret`) para uso em runtime (fetch do bot/sync).

Fluxo (`renderer.js`):
- `main.js` expõe IPC `encrypt-secret`/`decrypt-secret` (via `preload.js` → `window.electronAPI.encryptSecret/decryptSecret`), cada um retornando `{ available, value }`.
- `saveConfigToStorage()` remove `tgToken`/`sheetsSecret` (texto puro) do objeto antes de gravar, mantendo só os `*Enc` — exceto em modo web ou fallback.
- `refreshSecretCache()` (async) recifra os segredos em texto puro para o cache `*Enc`; chamada em `saveConfigSettings()` antes de persistir.
- `hydrateSecrets()` (async, chamada em `init()` após `loadConfig()` e no restore) descriptografa os `*Enc` para memória e **migra** automaticamente tokens em texto puro de versões anteriores (cifra + regrava, removendo o texto puro do storage).
- **Fallback gracioso:** se `safeStorage.isEncryptionAvailable()` for `false`, `secretsPlaintextFallback=true` — mantém texto puro no `localStorage` (não quebra o app) e avisa o usuário via `notify()`. Modo web (sem Electron) idem — limitação conhecida.
- **Backup:** `SECRET_CONFIG_KEYS` (`tgToken`, `tgTokenEnc`, `sheetsSecret`, `sheetsSecretEnc`, `appsScriptUrl`) são removidos do `config` em `buildBackupPayload()` — o backup nunca contém credenciais (nem cifradas — a chave do `safeStorage` é atrelada ao dispositivo de origem). O restore preserva as credenciais do dispositivo atual via `keepLocal`.

### Nunca logar segredos
`scrubSecrets(str)` substitui, em qualquer string de log, o `tgToken` (→ `maskToken()`, ex. `123456:***`) e o `sheetsSecret` (→ `***`) pelos valores mascarados. Aplicado centralmente em `addLog()` e nos `console.error` do sync. Ao adicionar novo log que possa conter URL/credencial, passe por `scrubSecrets()`.

### Nunca fazer
- Aumentar escopo de `nodeIntegration`, desativar `contextIsolation` ou desativar `sandbox`
- Remover a CSP ou afrouxá-la para `default-src *`/adicionar `'unsafe-eval'`
- Voltar a carregar Chart.js/xlsx/fontes por CDN (reintroduz supply-chain e viola a CSP)
- Executar conteúdo do Telegram como código
- Armazenar token no código-fonte
- Reativar o bot interno (`startBot`) na inicialização — conflito 409 com bot do Render

---

## Auto-Update (`electron-updater` + GitHub Releases)

`main.js` usa `electron-updater` com provider `github` (`owner: otreblag`, `repo: gastos-casal-app`, config em `package.json` → `build.publish`). `autoDownload: true`, `autoInstallOnAppQuit: true`.

**`checkForUpdates(manual = false)`** — chamada silenciosa na inicialização (`manual=false`) e pelo menu Arquivo → "Verificar atualizações" / botão "🔄 Verificar atualizações" no card Sobre (`manual=true`, via IPC `check-for-updates`). Só quando `manual` é `true` os dialogs de feedback aparecem:
- App não empacotado (`!app.isPackaged`, ou seja rodando via `npm start`) → dialog explicando que só funciona no `.exe` instalado
- Já na versão mais recente → dialog "Você já está usando a versão mais recente"
- Erro (rede, GitHub, etc.) → dialog com a mensagem de erro

Sem `manual=true`, essas três situações só logam no console — nunca incomodam o usuário na inicialização silenciosa.

**Fechamento durante a instalação da atualização** — `win.on('close', ...)` normalmente intercepta o fechamento e minimiza para a bandeja (`tray && !isQuitting`). Isso quebrava o auto-update ("Não é possível fechar o Finannza") porque o `quitAndInstall()` não conseguia encerrar o processo de verdade. Fix: uma flag global `isQuitting`, setada `true` (a) antes de chamar `quitAndInstall()` no handler de `update-downloaded` — junto com `tray.destroy()` e `win.close()` explícito — e (b) no evento `app.on('before-quit', ...)`, cobrindo o "Sair" do menu também. Com `isQuitting=true`, o `close` handler deixa a janela fechar de verdade em vez de escondê-la.

`autoUpdater.quitAndInstall(true, true)` — `isSilent=true` e `isForceRunAfter=true`. **`isSilent` é o parâmetro que realmente controla a tela do instalador** — quando `true`, o `electron-updater` invoca o instalador NSIS com a flag `/S` (`NsisUpdater.js` → `doInstall()`: `if (options.isSilent) args.push("/S")`), e a engine do NSIS pula a exibição de **toda e qualquer página** (boas-vindas, escolha per-user/all-users, diretório, progresso), **independente de `oneClick:true` ou `false`** — `oneClick` só decide qual variante do script é compilada, não se `/S` funciona em runtime. Chegamos a rodar com `isSilent=false` numa correção anterior (achando que só suprimia o wizard "grande" mas mantinha uma telinha de progresso) — **estava errado**: `false` roda o instalador 100% interativo, mostrando o wizard completo de novo a cada atualização automática. `isSilent=true` é a forma correta e documentada de ter os dois comportamentos ao mesmo tempo: wizard completo na instalação manual (`oneClick:false` no `package.json`) e silencioso no auto-update.

**Por que a tela de escolha "todos os usuários / só eu" não reaparece na atualização automática (mesmo antes desse fix, para instalações manuais repetidas):** o instalador NSIS gerado pelo electron-builder usa `MultiUser.nsh`, que detecta uma instalação existente no registro do Windows e reaproveita o modo escolhido anteriormente — independente de como o instalador foi invocado. Isso é ortogonal ao `isSilent`: mesmo instalando manualmente (com wizard visível) sobre uma instalação já existente, essa tela específica é pulada; ela só aparece quando não há instalação prévia detectável.

**`releaseType: "release"`** em `build.publish` (package.json) — **crítico**. Sem essa opção, o electron-builder publica os releases do GitHub como **draft**, invisíveis para o `electron-updater` (e para qualquer usuário navegando os releases sem estar autenticado). Isso já aconteceu nos releases v1.0.0/v1.1.0/v1.1.1 — todos ficaram presos como draft até serem publicados manualmente via API. Sempre confirme `draft: false` após `npm run release` (`gh api` ou a REST API do GitHub com um token autenticado — a listagem pública de releases não mostra drafts, então checar sem autenticação dá falso-negativo).

**IPC exposto via `preload.js`** (`window.electronAPI`):
- `getAppVersion()` → `app.getVersion()` (lê `package.json` do lado do main process — nunca hardcode a versão no HTML/renderer)
- `getBuildDate()` → mtime de `app.getAppPath()` (aproximação de "última atualização"; `null` se indisponível)
- `checkForUpdates()` → dispara `checkForUpdates(true)` no main via `ipcRenderer.send('check-for-updates')`

---

## Ícones do App (`assets/`)

`icon.ico` (janela + taskbar + instalador NSIS), `icon.png` (fallback), `tray-icon.png` (bandeja) — referenciados em `main.js` (`createWindow()`, `createTray()`) e em `package.json` (`build.win.icon`, `build.nsis.installerIcon/uninstallerIcon/installerHeaderIcon`). Ao trocar esses arquivos manualmente (GIMP, Convertio, etc.), não é necessário mudar nenhuma referência de código — os três nomes de arquivo já são fixos.

**`icon.ico` precisa ser multi-resolução (16/24/32/48/64/128/256px), não só um frame de 256px.** Um `.ico` com um único frame grande faz o Windows reduzi-lo *on the fly* pra qualquer tamanho pequeno (barra de título, taskbar, Alt+Tab) — e esse downscale nativo do Windows corrompe visivelmente o canal alfa, aparecendo como um quadriculado/dithering nas bordas transparentes. **Isso já aconteceu de verdade** com o `.ico` gerado manualmente no GIMP/Convertio (só tinha o frame 256×256). Confirmado extraindo o ícone direto do recurso PE do `.exe` via `PrivateExtractIcons` (bypassa qualquer cache do shell) nos tamanhos 16/32/48px — mostrava o quadriculado mesmo assim, provando que era o arquivo, não cache do Windows.

Fix: reempacotar a partir do `icon.png` atual (mesma arte, só o container muda) com múltiplas resoluções, deixando o Windows usar o frame pequeno já pronto em vez de reduzir o grande:
```python
from PIL import Image
img = Image.open('assets/icon.png').convert('RGBA')
img.save('assets/icon.ico', format='ICO', sizes=[(s,s) for s in (16,24,32,48,64,128,256)])
```
PIL redimensiona cada tamanho com LANCZOS internamente — é o mesmo método que `generate_icons.py` (script antigo, design diferente) já usava. Ao gerar um novo ícone em ferramenta externa (GIMP, Convertio, etc.), sempre exporte/reempacote como `.ico` multi-resolução — nunca só o frame grande.

**Depois de corrigir o `.ico` e reinstalar, o ícone quebrado pode continuar aparecendo especificamente no botão da barra de tarefas** (mesmo com o `.exe` já correto e a janela/título já renderizando limpo) — isso é o **cache de ícones do Explorer** (`iconcache_*.db`), uma camada separada do ícone ao vivo da janela. Ele é populado uma vez por caminho de arquivo e não invalida sozinho quando o `.exe` é substituído/atualizado no mesmo lugar — nem reiniciar o app resolve, só reiniciar o `explorer.exe` (ou reboot). Diagnóstico: se `PrintWindow` na própria janela mostra o ícone limpo mas o botão da taskbar mostra quadriculado, é esse cache — reinicie o Explorer pra confirmar.

---

## Como Executar

```bash
npm start          # desenvolvimento
npm run build:win  # gera instalador .exe em /dist (sem publicar)
npm run release    # gera o instalador e publica no GitHub Releases (precisa de GH_TOKEN no ambiente)
```

Requer Node.js + npm. `electron` e `electron-builder` são devDependencies.

---

## Histórico de Versões (Changelog)

Versão lida via IPC (`getAppVersion()` → `app.getVersion()`), nunca hardcoded. Releases publicados no GitHub (`otreblag/gastos-casal-app`) via `npm run release`. Sempre confirmar `draft:false` após publicar (ver seção Auto-Update). Datas em 2026.

> A série `1.1.x` fechou na **1.1.10** e a **1.2.0** abriu o novo ciclo (pós-hardening de segurança). Ao publicar a próxima, atualize `package.json`, adicione a linha aqui e siga o fluxo normal de `npm run release` (confirme `draft:false` depois).

| Versão | Data | Resumo |
|---|---|---|
| **1.2.0** | 07-21 | **Modelo de divisão por fatura + faxina de UI.** Quem paga a fatura do cartão do Casal virou propriedade de cada mês (`faturaPagamentos[]`, seletor por fatura na aba Divisão) em vez de campo fixo do cartão. Gastos manuais do Casal pagos por uma pessoa só entram na divisão como dívida (`expense.pagoPor` + seletor no modal de edição, badge `💸 adiantou`). Remoção do botão "Iniciar bot" e do badge de status do header (o bot do Render é o único). Hardening: allowlist de caminhos nos IPC de arquivo + guardas de navegação (`setWindowOpenHandler`/`will-navigate`) + validação do `merchantMap`. |
| **1.1.10** | 07-10 | **Backup seguro + revisão de segurança.** Backup com senha opcional (AES-256-GCM + scrypt via IPC `backup-seal`/`backup-open`), checksum SHA-256 de integridade (avisa se corrompido/alterado) e snapshot pré-restauração rotacionado (mantém as 3 versões mais recentes). `SECURITY.md` na raiz (arquitetura, credenciais, modelo de ameaça, resposta a incidentes, checklist). `npm audit fix` não-breaking (`form-data`→4.0.6, `js-yaml`→4.3.0). Inclui as mudanças da 1.1.9 (nunca lançada isoladamente). |
| **1.1.9** | 07-09 | **Validação/sanitização de dados externos.** Helpers `sanitizeText`/`sanitizeMoney`/`sanitizeDateBR`/`asArray`/`asObject` aplicados na ingestão (sync do Sheets, bot, importação de fatura, `addExpenseObj`, `loadAll`/`migrateData`): valores fora de `0..1M`, datas absurdas e registros malformados são descartados/truncados com log discreto; JSON corrompido não zera nem corrompe os dados existentes. Auditoria confirmou cobertura 100% de `escapeHtml()` (sem lacuna de XSS). |
| **1.1.8** | 07-09 | **Segredos criptografados em repouso.** `safeStorage` (DPAPI) para `tgToken`/`sheetsSecret` — localStorage guarda só as versões cifradas, texto puro só em memória; migração automática de texto puro + fallback gracioso. Backup deixa de incluir credenciais (`buildBackupPayload()` remove `SECRET_CONFIG_KEYS`) + aviso na UI. Logs mascarados (`scrubSecrets()`/`maskToken()`). `.gitignore` cobre `finannza-backup-*.json`/`.env`; repo do bot ganhou `.gitignore` + `.env.example`. |
| **1.1.7** | 07-09 | **Hardening do Electron.** `sandbox: true` explícito. Dependências de CDN (Chart.js, SheetJS, fonte Manrope) auto-hospedadas em `src/vendor/` → app funciona offline, sem supply-chain. CSP restritiva via `onHeadersReceived` (`'unsafe-inline'` temporário; `connect-src` libera Telegram + Apps Script + `script.googleusercontent.com`). |
| **1.1.6** | 07-09 | Badge de versão movido do canto inferior direito para o esquerdo (sobrepunha a scrollbar nativa de `.content`). |
| **1.1.5** | 07-09 | Correção real da corrupção do ícone: `icon.ico` precisava ser multi-resolução (16–256px), não só um frame 256px — o downscale nativo do Windows corrompia o alfa (quadriculado na taskbar). Reempacotado via PIL. |
| **1.1.4** | 07-09 | Auto-update parou de reabrir o wizard NSIS completo: `quitAndInstall(true, true)` (`isSilent=true` → flag `/S`). Badge de versão no header + card "Sobre" na Config (lidos via IPC). |
| **1.1.3** | 07-09 | Atualização dos assets de ícone do app (`icon.ico`/`icon.png`/`tray-icon.png`). |
| **1.1.2** | 07-09 | Fix "Não é possível fechar o Finannza" durante a instalação do auto-update (flag `isQuitting` para o handler de `close` parar de minimizar para a bandeja). |
| **1.1.1** | 07-08 | Redesign do header ("FINANNZA", "ANN" dourado, sem logo). Feedback de "Verificar atualizações" (dialogs no modo manual). `releaseType: "release"` no `build.publish` (corrige releases presos como draft). Primeiro release publicado com sucesso. |
| **1.1.0** | 07-08 | Rebrand de "Gastos do Casal" para **Finannza**. ⚠️ Release ficou preso como **draft** (bug do `releaseType`, corrigido na 1.1.1) — nunca chegou aos usuários. |
| **1.0.0** | 07-08 | Commit inicial: app Electron de controle financeiro do casal, com auto-update (`electron-updater` + GitHub Releases). ⚠️ Release **draft** (mesmo bug). |

> Notas: v1.0.0 e v1.1.0 permanecem como **draft** no GitHub (superseded, invisíveis ao `electron-updater`) — não republicar. A cadeia de auto-update efetiva começa na v1.1.1. Ao publicar uma nova versão, adicione a linha correspondente aqui.
