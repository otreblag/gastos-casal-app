# 📋 Backlog — Finannza

> **Revisado em 12/07/2026** (auditoria código-a-código). A maior parte do que
> estava aqui como "não implementado" **já foi construído** em sessões
> seguintes — movido para a seção "✅ Concluídos" no fim. Restam poucos itens
> realmente pendentes, listados primeiro.

---

## 🔲 Pendente

### 🔒 Débitos técnicos de segurança (do SECURITY.md)
Nenhum é urgente; ficam registrados para não se perderem. Verificados como
**ainda pendentes** em 12/07/2026:

| Item | Descrição | Prioridade |
|---|---|---|
| **CSP estrita (Etapa 2A)** | Remover `'unsafe-inline'` de `script-src`/`style-src` refatorando ~60 `onclick=`/`style=` inline para `addEventListener`/classes | Baixa — trabalho grande, risco de regressão |
| **Upgrade Electron/electron-builder** | Hoje `electron ^29` / `electron-builder ^24` têm CVEs conhecidas; upgrade é *breaking change* (Electron 43, electron-builder 26) | Baixa — avaliar quando houver tempo p/ testar a fundo |
| **Upgrade node-telegram-bot-api** | 9 vulnerabilidades na árvore da lib `request` (depreciada); fix exige troca de major | Baixa — bot só fala com origens confiáveis |
| **Assinatura de código do instalador** | O `.exe` não é assinado (Windows mostra "editor desconhecido") | Baixa — custo de certificado |

> ✅ **Feito em 12/07/2026:** *Allowlist de caminhos nos IPC* (`read-file`/`write-file`/`delete-file`/`list-dir`/`file-exists` restritos a userData + pasta registrada + diálogos nativos) e *guardas de navegação* (`setWindowOpenHandler`/`will-navigate`). Ver SECURITY.md.

```
Se for atacar algum destes, peça um diagnóstico atualizado de cada um antes
de implementar — as versões de dependências mudam com o tempo.
```

### 🧠 ~~Validar — aprendizado do classificador (merchantMap)~~ ✅ Validado (12/07/2026)
Exercitadas as funções reais: 1ª e 2ª correção da mesma descrição → **sugestão**
(`suggested`); na **3ª**, `autoAplicar` liga e a importação seguinte
**auto-aplica** a correção (`autoApplied`, descrição substituída). Prefixo `*`
casa por `startsWith`. Funciona conforme planejado. *(dados de teste
restaurados — merchantMap segue `{}` até o usuário corrigir de verdade)*.

---

## ✅ Concluídos (auditados no código em 12/07/2026)

Tudo abaixo estava no backlog como pendente e **hoje está implementado e
funcional** — confirmado por leitura do código, não só da documentação.

- **Contas variáveis** (água, luz, condomínio, gás, internet) — `fixedExpenses[].tipo==='variavel'`; estimativa = média dos últimos 6 confirmados (`_calcVariavelEstimate`); geração automática com `isEstimate:true`/`valorEstimado`; badges 📊 Estimativa / ✅ Valor real / 📊 variável; sparkline + méd/mín/máx + tendência ↑↓→ + "Estimativa próximo mês" na aba Fixas; lembrete no Dashboard "N contas variáveis aguardam confirmação". *(ver CLAUDE.md → Despesas Fixas)*
- **Metas de economia mensal** — card "🎯 Meta do mês" na aba Orçamento (`saveMonthGoal`/`renderMonthGoal`/`copyGoalFromPrevMonth`), barra de progresso, "Economia projetada", e **5º card de métrica "Meta do mês"** no Dashboard (`#m-meta`, oculto até haver meta).
- **Evolução mensal** — card "📈 Evolução mensal" (Relatórios): linha dos últimos 6 meses (Chart.js), seletor de modo `#evolution-mode` (total / por categoria), linha tracejada do teto da meta, e resumo textual "maior alta/queda" (`renderEvolutionSummary`, `topGrowth`/`topDrop`). Usa `mesCompetencia` p/ crédito.
- **Fatura atual (ciclo em aberto)** — seção "💳 Faturas em aberto" (`renderFaturas`): um card por cartão de crédito com total do ciclo, barra de progresso, "Fecha em X dias · Vence dia DD/MM" e lista expansível das transações (`_toggleFaturaDetail`). Estado vazio com link p/ Config.
- **Divisão anual acumulada** — card "📊 Saldo anual acumulado" (`_calcAnnualBalance`), tabela mês a mês, navegação de ano (`navAnnualYear`) e "Registrar acerto" (`openAcertoModal`/`confirmarAcerto` → `acertos[]`). *(ver CLAUDE.md → Saldo Anual)*
- **Aprendizado do classificador (merchantMap)** — implementado (falta só validar na prática, acima).
- Cadastro de cartões c/ atribuição automática · bot com cartões via Telegram · filtros avançados + ordenação (grid responsivo) · alertas de vencimento · backup manual com senha + checksum · snapshots automáticos diários (30d) · migração de pasta órfã (pós-rebrand) · revisão de segurança (sandbox, CSP, tokens cifrados, validação, rate limiting) · auto-update · importação de fatura C6 · tipografia legível (Inter + IBM Plex Mono).

---

## 📌 Se for retomar

Praticamente só sobram os **débitos de segurança** (sem pressa) e **validar o
merchantMap** (rápido). Ideias novas de produto podem ser adicionadas aqui
conforme surgirem.
