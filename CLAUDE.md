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
.claude/
  settings.json      # Permissões auto-aprovadas do Claude Code
package.json         # Electron 29 + electron-builder
```

**Sem framework de UI, sem bundler, sem TypeScript.** Tudo é JS vanilla. O renderer roda com `nodeIntegration: false` + `contextIsolation: true`; a única ponte com o processo principal é `preload.js` (`contextBridge.exposeInMainWorld`), exposta como `window.electronAPI` (`readFile`, `writeFile`, `selectFolder`, `saveFileDialog`, `openFileDialog`, etc.). Isso é intencional para manter zero configuração de build.

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

O botão "▶ Iniciar bot" na UI ainda existe e pode ser usado manualmente para testes emergenciais, mas não deve ser ativado em uso normal.

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

**Arquivo de trabalho do bot:** `C:\Users\gabal\Downloads\bot.js` (cópia local mais atualizada).

**Variáveis de ambiente lidas pelo bot** (`process.env`):
- `TELEGRAM_TOKEN` — token do bot
- `TELEGRAM_GROUP_ID` — ID do grupo autorizado
- `APPS_SCRIPT_URL` — URL do Web App publicado no Google Apps Script
- `SECRET_TOKEN` — token de autenticação entre bot e Apps Script

**`salvarNaplanilha(gasto)`** — usa `fetch` nativo (Node 18+) com `redirect: 'follow'`. O Apps Script retorna 302 que o fetch segue automaticamente. Erro "Invalid URL" indica que `APPS_SCRIPT_URL` está vazia ou malformada no ambiente do Render.

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

---

## Cartões e Competência de Fatura (`cards`)

Cada cartão em `cards[]`: `{ id, nome, final (4 dígitos), titular, divisao (% do dono, default 100), tipo ('Crédito'|'Débito'), dono, diaFechamento, diaVencimento, cor, avisoAntecedencia, ativo }`. CRUD via `openCardForm()` / `saveCard()` / `deleteCard()`, renderizado em `renderCardsList()` (aba Config, card "💳 Meus cartões").

**`calcularMesCompetencia(dataCompra, metodo, cardId)`** decide em qual mês um gasto "pesa" no orçamento:
- Débito / Pix / Dinheiro → mês da própria compra (dinheiro já saiu da conta)
- Crédito → mês de **vencimento da fatura**: compra após o `diaFechamento` cai na fatura seguinte; a fatura vence no mês do fechamento ou no seguinte, dependendo se `diaVencimento <= diaFechamento`
- Fechamento/vencimento não configurados (cartão sem essas datas ou `appConfig.diaFechamento/diaVencimento` como fallback) → retorna o mês da compra (comportamento neutro)

O resultado fica em `expense.mesCompetencia` (`'YYYY-MM'`). **Todo lugar que filtra despesas por mês para métricas de orçamento** (`contextMonthExpenses()`, `_calcAnnualBalance()`, evolução mensal) usa `mesCompetencia` para lançamentos de Crédito em vez de `data`. Badge `💳 a pagar <mês>` / `💳 pago` aparece em `expenseItemHTML()` quando `mesCompetencia` diverge do mês da compra.

**Importação de fatura** (botão "📄 Importar fatura" na aba Lançamentos → `openInvoiceImport()`): `handleInvoiceFile()` lê um `.xls`/`.xlsx` (formato fatura C6 Bank) via SheetJS (`XLSX`, carregado por CDN), extrai `Data de compra`, `Descrição`, `Valor (em R$)`, `Parcela` e `Final do Cartão`. `_renderInvoicePreview()` (modal `#invoice-modal`) detecta o cartão automaticamente pelos 4 últimos dígitos (`finalToCard`), aplica `merchantMap` (auto-correção ou sugestão) e mostra uma tabela de pré-visualização antes de confirmar a importação. Lançamentos importados recebem `origem: 'fatura'`. O card "💳 Cartão de Crédito" na aba Config guarda apenas o fechamento/vencimento *padrão* (fallback para gastos sem `cardId`) e o botão "🔄 Recalcular competências" (`recalcularCompetencias()`).

---

## Aprendizado de Classificação (`merchantMap`)

Corrige e memoriza descrições de fatura que a classificação por palavra-chave erra sistematicamente (ex: `"IFD*MOKKA FLORIPA"` → "iFood" / Alimentação).

- Chave: descrição original exata, ou prefixo com `*` no final (ex: `IFD*`) para casar por `startsWith`
- `_merchantLookup(desc)` — busca exata primeiro, depois prefixos com `*`
- `_merchantLearn(origKey, newDesc, newCatId, newCatNome)` — incrementa `vezesCorrigido`; ao atingir **3 correções**, liga `autoAplicar = true` automaticamente
- Cadastro manual: aba Categorias → card de aprendizado → `saveMerchantMapping()` (já cria com `autoAplicar: true` direto)
- Com `autoAplicar` ligado, a próxima importação de fatura já chega com a descrição/categoria corrigidas (`t.autoApplied = true`, badge `🤖 auto`); sem isso, aparece só como sugestão (`t.suggested`)

---

## Metas Mensais e Gráfico de Evolução

`monthGoals[]`: `{ month ('YYYY-MM'), teto, renda }` — uma entrada por mês, gerenciada na aba Orçamento (card "🎯 Meta do mês"). `saveMonthGoal()` substitui a entrada do mês atual; `copyGoalFromPrevMonth()` clona a meta do mês anterior; `deleteMonthGoal()` remove. `renderMonthGoal()` mostra barra de progresso do gasto atual contra o teto e a linha "💰 Economia projetada" (projeção baseada no ritmo atual de gastos vs. `renda`).

O gráfico de evolução (`renderEvolutionChart()` + `renderEvolutionSummary()`, Dashboard) usa Chart.js 4.4.1 via CDN — linha dos últimos 6 meses com `borderDash: [6, 4]` marcando o teto da meta (`spanGaps: true` para meses sem meta). O resumo mostra "Mês atual vs anterior: ±X% (R$ valor)".

---

## Saldo Anual Acumulado e Acertos de Conta (`acertos`)

Card "📊 Saldo anual acumulado" na aba Divisão, acima do card mensal existente. `_calcAnnualBalance(year)` é uma função pura que recalcula, mês a mês, `runningBalance += (p1Paid - p2Paid)` e aplica os acertos do mês (`de === p2 → runningBalance -= valor`; `de === p1 → runningBalance += valor`), retornando `{ rows, annualP1, annualP2, finalBalance }`. Positivo = p1 está a receber; negativo = p2 está a receber.

`acertos[]`: `{ id, de, para, valor, data (DD/MM/YYYY), nota, contexto, criadoEm }` — um registro de Pix que "zera" o saldo até aquele ponto. Fluxo: `openAcertoModal()` pré-calcula a direção e o valor (`Math.abs(finalBalance) / 2`) → `confirmarAcerto()` grava em `acertos[]` e chama `saveAll()` → `deleteAcerto(id)` remove. Navegação de ano via `navAnnualYear(±1)`, estado em `_annualYear` (não persistido — sempre reinicia no ano de `currentMonth`).

---

## Filtros Avançados e Ordenação (Lançamentos)

Estado em `_listFilters` (pessoa, dateFrom, dateTo, valorMin, valorMax, metodo, cardId, origem — todos combinados em AND) e `_listSort` (`field: 'data'|'valor'|'categoria'`, `dir: 'asc'|'desc'`), ambos não persistidos. `renderList()` aplica busca full-text + filtro de categoria (pills, `activeFilter`) + `_listFilters` + `_listSort`, nessa ordem, sobre `contextMonthExpenses()`.

- `toggleAdvancedFilters()` abre/fecha o painel `#advanced-filters` (`_advFiltersOpen`)
- `_handleFilterPillClick()` alterna pills de pessoa/método/origem (clique de novo desmarca)
- `_setListSort(field)` alterna direção se clicar no mesmo campo já ativo
- `clearAllListFilters()` reseta filtros, ordenação **não muda**; `clearFilters()` é apenas um alias legado
- `_renderFilterSummary()` mostra a barra "N de M itens" com resumo dos filtros ativos

---

## Backup e Restauração

Card "Backup" na aba Config. `exportBackup()` grava um JSON com `_version`, `appVersion: '2.0'`, `backupDate`, todo o estado (`expenses`, `customCats`, `budgets`, `fixedExpenses`, `cards`, `monthGoals`, `merchantMap`, `acertos`, `deletedIds`) e `config` (cópia de `appConfig`).

`importBackup()` → `_processImport(data)` mostra um resumo (contagens, incluindo mapeamentos aprendidos e acertos) e pede confirmação → `executeRestore()`:
1. Salva um snapshot de segurança do estado atual em `gastos-pre-restore.json` **antes** de sobrescrever qualquer coisa
2. Roda `migrateData(data)` para normalizar/backfillar campos que possam faltar num backup antigo (`merchantMap`, `acertos`, etc. default para `{}`/`[]`)
3. Restaura todos os arrays de estado + `merchantMap`/`acertos`
4. **Nunca** sobrescreve `appConfig.dataFolderPath` — é uma configuração local da máquina, preservada via `keepLocal`

---

## Estrutura das Abas

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
card "🗄️ Backup" — #backup-info (data do último backup) + exportar/importar (exportBackup() / importBackup())
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

Fonte: `'Segoe UI', system-ui, -apple-system, sans-serif` · 13px base

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
- Token do Telegram salvo em `localStorage`/`gastos.json` (dentro de `appConfig`) em texto plano.
- Token do Telegram exposto na URL de fetch — aparece em logs de rede.

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

---

## Segurança

### Electron hardening (`main.js`) — já implementado
```js
webPreferences: {
  nodeIntegration: false, contextIsolation: true,
  preload: path.join(__dirname, 'preload.js'),
}
```
Toda comunicação com o processo principal passa por `preload.js` (`contextBridge.exposeInMainWorld('electronAPI', ...)`). Não reintroduza `nodeIntegration: true` nem `contextIsolation: false`.

### Prioridade 1 — Sanitização de HTML
`escapeHtml()` já existe no renderer e é aplicado consistentemente em `descricao`/`categoria`/`pessoa`/`data` nos pontos de `innerHTML` já auditados (`expenseItemHTML()`, relatórios, listas de parcelas/cartões). Ao adicionar novo template literal com dado do usuário, sempre passe por `escapeHtml()`.

### Prioridade 2 — Token do Telegram
Mova para `electron-store` com criptografia opcional ou `safeStorage` do Electron.

### Nunca fazer
- Aumentar escopo de `nodeIntegration` ou desativar `contextIsolation`
- Executar conteúdo do Telegram como código
- Armazenar token no código-fonte
- Reativar o bot interno (`startBot`) na inicialização — conflito 409 com bot do Render

---

## Como Executar

```bash
npm start          # desenvolvimento
npm run build:win  # gera instalador .exe em /dist
```

Requer Node.js + npm. `electron` e `electron-builder` são devDependencies.
