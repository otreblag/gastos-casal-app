# Segurança — Finannza

Documento de referência sobre a arquitetura de segurança, armazenamento de
credenciais, modelo de ameaça e resposta a incidentes. Complementa a seção
**Segurança** do `CLAUDE.md` (detalhes de implementação por função).

> Última revisão: 2026-07-10 · app v1.1.9 · bot `otreblag/gastos-bot`

---

## 1. Arquitetura de segurança

O sistema tem três componentes, cada um com sua fronteira de segurança:

### App Electron (desktop, Windows) — `otreblag/gastos-casal-app`
- **Isolamento do renderer:** `nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: true`. O renderer não tem acesso a Node; toda ponte com o processo
  principal passa por `preload.js` via `contextBridge` (`window.electronAPI`),
  que expõe **apenas funções nomeadas específicas** — nunca `ipcRenderer` cru.
- **Content Security Policy** restritiva aplicada a todas as respostas
  (`onHeadersReceived`): `default-src 'self'`; `connect-src` só libera
  `api.telegram.org`, `script.google.com` e `script.googleusercontent.com`;
  `object-src 'none'`; `base-uri 'none'`.
- **Dependências auto-hospedadas** (`src/vendor/`): Chart.js, SheetJS e a fonte
  Manrope são servidos localmente, não por CDN — elimina supply-chain de CDN e
  faz o app funcionar offline.
- **Sanitização de saída (XSS):** `escapeHtml()` em 100% dos pontos de
  `innerHTML` que recebem dado externo.
- **Validação de entrada:** dados de fontes externas (sync, bot, fatura) passam
  por `sanitizeText`/`sanitizeMoney`/`sanitizeDateBR`/`asArray`/`asObject` —
  valores fora de faixa/malformados são descartados ou truncados.
- **Segredos em repouso:** `safeStorage` (DPAPI no Windows) — ver seção 2.
- **100% local:** todos os dados financeiros ficam em `gastos.json` na máquina.
  As únicas chamadas de rede são para a API do Telegram (bot interno, desativado
  por padrão) e o Apps Script (sync). Nenhum dado vai para nuvem de terceiros.

### Bot do Telegram (servidor externo, Railway/Render) — `otreblag/gastos-bot`
- **Segredos só via variáveis de ambiente** (`process.env`), nunca hardcoded.
- **Validação da URL do Apps Script** no startup (precisa começar com
  `https://script.google.com/`) — impede exfiltração para endpoint arbitrário.
- **Rate limiting:** máx. 10 mensagens por chat em 30s (anti-flood).
- **Limite de tamanho:** mensagens acima de 500 caracteres são ignoradas.
- **Mascaramento de logs:** `maskSecrets()`/`maskToken()` — token, secret e URL
  do Apps Script nunca aparecem em log (inclui o `polling_error`, que costuma
  trazer a URL da API do Telegram com o token no path).

### Google Apps Script (endpoint da planilha)
- **Autenticação primeiro:** o `SECRET_TOKEN` é validado **antes** de qualquer
  leitura/escrita na planilha. Sem o token correto, nenhuma operação acontece.
- **Validação de campos:** valor numérico em `0..1.000.000`, strings truncadas,
  caracteres de controle removidos, antes de gravar.
- **Idempotência:** um mesmo ID de gasto que chega duas vezes (checado nas
  últimas 100 linhas) não duplica a linha.
- **"Who has access: Anyone" é intencional:** o Google exige esse modo para um
  cliente sem login Google. A proteção real é o `SECRET_TOKEN` (bearer secret).

### Backup / Restauração
- Backup **nunca contém credenciais** (`SECRET_CONFIG_KEYS` removidas).
- **Criptografia opcional por senha** (AES-256-GCM, chave derivada por scrypt).
- **Integridade:** checksum SHA-256 do conteúdo, verificado na importação.
- **Snapshot rotacionado** antes de restaurar (mantém as 3 versões mais recentes).

---

## 2. Onde cada credencial é armazenada e como é protegida

| Credencial | Bot (servidor) | App Electron | Apps Script | Em backup? | Em log? |
|---|---|---|---|---|---|
| **Token do Telegram** (`TELEGRAM_TOKEN` / `tgToken`) | Env var (Railway/Render) | `safeStorage`/DPAPI → `localStorage` cifrado (`tgTokenEnc`); texto puro só em memória | — | ❌ nunca | mascarado `123456:***` |
| **Secret do Apps Script** (`SECRET_TOKEN` / `sheetsSecret`) | Env var | `safeStorage`/DPAPI (`sheetsSecretEnc`) | Script Properties | ❌ nunca | mascarado `***` |
| **URL do Apps Script** (`APPS_SCRIPT_URL`) | Env var (validada) | `localStorage` texto puro (não é segredo em si) | — | ❌ nunca | mascarado `<apps-script-url>` |
| **Token do GitHub** (`GH_TOKEN`) | — | — | — | ❌ | nunca logado |

Notas:
- **`safeStorage`** usa a DPAPI do Windows, atrelada à conta do SO. O
  `localStorage` guarda só o blob cifrado em base64. Se a criptografia estiver
  indisponível (raro), há fallback gracioso para texto puro com aviso ao usuário.
- **`GH_TOKEN`** é usado apenas no `npm run release`, na máquina do desenvolvedor,
  como variável de ambiente. Não está no código, no app nem no repositório.
- A `URL do Apps Script` não é secreta sozinha (ela só aceita requisições com o
  `SECRET_TOKEN`), mas é tratada com cuidado por ser o caminho de acesso.

---

## 3. Modelo de ameaça

### ✅ No escopo (o sistema protege contra)
- **Segredos em repouso no disco** — cifrados com DPAPI; `localStorage` não tem
  texto puro.
- **Vazamento de segredo via backup** — credenciais são removidas do backup.
- **Vazamento de segredo via log** — token/secret/URL mascarados em todos os logs
  (app e bot).
- **XSS a partir de dados externos** (Telegram/Sheets/fatura) — `escapeHtml()` +
  validação de entrada; um `<img onerror>` numa descrição vira texto literal.
- **Dados malformados/maliciosos quebrando o app** — validação/sanitização na
  ingestão; JSON corrompido não zera nem corrompe os dados existentes.
- **Supply-chain de CDN** — dependências auto-hospedadas.
- **Acesso não autorizado ao endpoint do Apps Script** — exige o `SECRET_TOKEN`.
- **Flood/abuso do bot** — rate limiting + limite de tamanho de mensagem.
- **Escopo de um renderer comprometido** — `contextIsolation` + `sandbox` + CSP
  limitam o alcance (sem acesso a Node/FS arbitrário direto).
- **Confidencialidade do backup em nuvem/compartilhamento** — opção de senha
  (AES-256-GCM).
- **Integridade do backup** — checksum SHA-256 detecta corrupção/adulteração.
- **Exfiltração por URL do Apps Script trocada** — validação de domínio no bot.

### ❌ Fora do escopo (riscos aceitos / não mitigados)
- **Comprometimento da conta do SO / malware rodando como o mesmo usuário.** A
  DPAPI é atrelada à conta do Windows — quem tem a sessão do usuário pode
  descriptografar os segredos. Isto é inerente a qualquer app desktop.
- **Acesso físico a uma máquina desbloqueada.**
- **Token do Telegram no path da URL da API** (`api.telegram.org/bot<token>/...`)
  — inerente à API do Telegram. Mitigado: nunca é logado em texto puro e o bot
  interno do app fica desativado (o bot externo é o único ativo).
- **Endpoint "Anyone" do Apps Script.** Qualquer um pode *chamar* o endpoint, mas
  sem o `SECRET_TOKEN` nada acontece. Se o secret vazar, um terceiro pode gravar
  na planilha até a rotação (ver seção 4).
- **Senha fraca escolhida pelo usuário no backup.** O scrypt encarece o
  brute-force, mas uma senha fraca continua fraca. Não há política de força.
- **Binário não assinado.** O `.exe` não tem assinatura de código (sem
  certificado). A autenticidade vem do canal de distribuição (GitHub Releases do
  `electron-updater`), não de uma assinatura Authenticode.
- **CVEs conhecidas de `electron`/`electron-builder`** pendentes de upgrade major
  (ver `## Dependências` abaixo). Mitigadas parcialmente pelo hardening (sandbox,
  CSP, contextIsolation) e por serem, em sua maioria, superfícies macOS/Linux ou
  de nicho.
- **Confiança na planilha/bot.** O app confia nos dados que o Apps Script devolve
  no sync (após validação de tipos). Um bot/planilha comprometidos poderiam
  injetar lançamentos (mas não executar código — os dados são escapados).

---

## 4. Resposta a incidentes — como revogar e rotacionar cada credencial

> Regra geral: após qualquer suspeita de vazamento, **rotacione primeiro**
> (invalida o valor vazado) e só depois investigue. Um segredo que já foi para
> um lugar não confiável deve ser considerado comprometido para sempre.

### 4.1 Token do bot do Telegram
1. No Telegram, abra o **@BotFather**.
2. `/token` (gera um novo token para o bot) **ou** `/revoke` (invalida o atual).
   O token antigo para de funcionar **imediatamente**.
3. Atualize a variável `TELEGRAM_TOKEN` no painel do **Railway/Render** e
   redeploy o bot.
4. Se o token estava configurado no app Electron, atualize-o em
   **Configurações → Token do bot** e salve (será re-cifrado via `safeStorage`).

### 4.2 Secret do Apps Script (`SECRET_TOKEN` / `sheetsSecret`)
1. Gere um novo valor secreto forte (ex.: 32+ caracteres aleatórios).
2. No editor do **Apps Script** (planilha → Extensões → Apps Script) →
   **Configurações do projeto → Propriedades do script** → edite `SECRET_TOKEN`.
3. Atualize a variável `SECRET_TOKEN` no **Railway/Render** (bot) e redeploy.
4. Atualize o **secret no app Electron** (Configurações → secret do Sheets).
5. O secret antigo é rejeitado **imediatamente** (a validação acontece antes de
   qualquer escrita). Não é preciso republicar o Web App — só a Script Property
   muda.

### 4.3 Token do GitHub (`GH_TOKEN`)
1. GitHub → **Settings → Developer settings → Personal access tokens** →
   localize o token e **Revoke/Delete**.
2. Gere um novo PAT com o escopo mínimo necessário (para publicar releases:
   `repo` / `contents:write` no repositório do app).
3. Atualize a variável de ambiente `GH_TOKEN` **apenas na máquina do
   desenvolvedor** (não vai para o código nem para o repo).
4. Como o token só existe localmente, não há redeploy — o próximo
   `npm run release` usa o novo valor.

### 4.4 Se um backup criptografado vazou
- O conteúdo está protegido por AES-256-GCM. Se a **senha era forte** e não
  vazou junto, o risco é baixo. Ainda assim, considere que os dados financeiros
  podem estar comprometidos e, por precaução, rotacione as credenciais acima
  (elas **não** estão no backup, mas a rotação é barata).
- Se a senha era fraca ou vazou junto, trate os dados financeiros como expostos.

---

## Dependências (npm audit) — estado atual

Auditado em 2026-07-10.

**App (`gastos-casal-app`):**
- ✅ **Corrigidas (não-breaking, aplicadas):** `form-data` (→ 4.0.6),
  `js-yaml` (→ 4.3.0) via `npm audit fix`.
- ⚠️ **Pendentes (exigem upgrade major — não aplicadas):**
  - `electron` <= 39.8.4 (várias advisories) → correção em `electron@43`
    (breaking). A maioria das advisories é de superfície macOS/Linux ou de
    nicho; o hardening (sandbox/CSP/contextIsolation) mitiga na prática.
    **Recomendado:** upgrade planejado de Electron + regressão completa.
  - `tar` (via `electron-builder`) → correção em `electron-builder@26`
    (breaking). **Build-time apenas** — não vai no `.exe` distribuído; risco de
    runtime nulo.

**Bot (`gastos-bot`):** 9 vulnerabilidades (7 moderate, 2 critical), **todas**
na árvore transitiva do `node-telegram-bot-api` (biblioteca `request`
depreciada → `tough-cookie`, `uuid`). Corrigir exige trocar o major do
`node-telegram-bot-api` (breaking). **Recomendado:** avaliar upgrade do
`node-telegram-bot-api` para a versão mais recente (que abandonou o `request`)
com teste do fluxo do bot. Risco atual mitigado: o bot só fala com
`api.telegram.org` e o Apps Script (origens confiáveis).

---

## Checklist final de segurança

### ✅ Implementado
- [x] `nodeIntegration: false` + `contextIsolation: true` + `sandbox: true`
- [x] Preload com `contextBridge` expondo só funções específicas
- [x] CSP restritiva via `onHeadersReceived` (`connect-src` allowlist)
- [x] Dependências auto-hospedadas (sem CDN, funciona offline)
- [x] `escapeHtml()` em 100% dos sinks de `innerHTML` com dado externo (sem XSS)
- [x] Validação/sanitização de dados externos (sync, bot, fatura, JSON)
- [x] Segredos cifrados em repouso (`safeStorage`/DPAPI) + migração + fallback
- [x] Backup nunca inclui credenciais
- [x] Backup com senha opcional (AES-256-GCM + scrypt)
- [x] Integridade do backup (checksum SHA-256)
- [x] Snapshot pré-restauração rotacionado (últimas 3 versões)
- [x] Logs mascaram token/secret/URL (app e bot)
- [x] Bot: secrets só via env, validação da URL do Apps Script, rate limiting,
      limite de tamanho de mensagem
- [x] Apps Script: auth antes de qualquer operação, validação de campos,
      idempotência
- [x] `.gitignore` cobre `.env`, backups e config local; `.env.example` no bot
- [x] Sem segredos hardcoded no código ou no histórico do git (auditado)
- [x] `npm audit fix` (não-breaking) aplicado no app
- [x] Allowlist de caminhos nos IPC de arquivo (`read-file`/`write-file`/`delete-file`/`list-dir`/`file-exists` só operam sob userData + pasta registrada + caminhos escolhidos em diálogo nativo)
- [x] Guardas de navegação (`setWindowOpenHandler` nega novas janelas; `will-navigate` bloqueia sair da URL local)

### 🔭 Melhoria futura (fora do escopo atual)
- [ ] Upgrade do Electron (29 → 43+) para zerar as advisories de `electron` — *breaking, exige regressão completa*
- [ ] Upgrade do `electron-builder` (resolve `tar`, build-time) — *breaking*
- [ ] Upgrade do `node-telegram-bot-api` no bot (resolve a árvore do `request`) — *breaking major*
- [ ] Assinatura de código (Authenticode) do instalador `.exe` — *precisa de certificado (custo)*
- [ ] Etapa 2A da CSP: remover `'unsafe-inline'` refatorando `onclick`/`style`
      inline para `addEventListener`/classes — *trabalho grande, alto risco de regressão*
- [ ] Política de força mínima para a senha de backup
- [ ] Rotação/expiração automática de credenciais
