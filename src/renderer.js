// ═══════════════════════════════════════════════════════════════
// FINANNZA — renderer.js
// ═══════════════════════════════════════════════════════════════

// ─── STATE ───────────────────────────────────────────────────────
let expenses       = [];
let fixedExpenses  = [];
let customCats     = [];
let budgets        = [];
let appConfig      = {};
let currentPerson  = '';
let currentContext = 'pessoal'; // 'pessoal' | 'empresa'
let selectedColor  = '#3266ad';
let activeFilter   = null;
let botRunning     = false;
let botInterval    = null;
let lastUpdateId   = 0;
let chartCat       = null;
let chartPerson    = null;
let chartEvolution     = null;
let _pendingRestoreData = null;
let currentMonth   = new Date().toISOString().slice(0, 7);
let dataFilePath   = null; // path to gastos.json (null = not yet resolved)
let deletedExpenseIds = new Set();
let cards       = [];
let monthGoals  = [];
let merchantMap = {};
let acertos     = []; // { id, de, para, valor, data (DD/MM/YYYY), nota, contexto, criadoEm }
// Pagamento da fatura de cada mês por cartão do casal — quem quitou de fato aquela
// fatura VARIA mês a mês (dividido / uma pessoa / valores personalizados). Ausência
// de registro = "dividido" (default). Ver seção Divisão.
// { cardId, mesCompetencia ('YYYY-MM'), formaPagamento: 'dividido'|'p1'|'p2'|'personalizado',
//   valorGabriel, valorAnna, pago, dataPagamento, contexto }
let faturaPagamentos = [];

// ─── LIST FILTER / SORT STATE (never persisted — reset on tab switch) ──────
let _listFilters = { pessoa: null, dateFrom: '', dateTo: '', valorMin: null, valorMax: null, metodo: null, cardId: null, origem: null };
let _listSort    = { field: 'data', dir: 'desc' };
let _advFiltersOpen = false;
let _annualYear  = '';

const DEFAULT_CONFIG = {
  p1Name: 'Gabriel',
  p2Name: 'Anna',
  coupleName: 'Casal',
  companyName: 'Empresa',
  tgToken: '',
  tgGroup: '',
  dataFolderPath: '',  // empty = use Electron userData (default)
  botWasRunning: false,
  appsScriptUrl: '',   // URL do Google Apps Script para sincronizar gastos do bot
  sheetsLastSync: 0,   // timestamp da última sincronização
  diaFechamento: 0,    // dia de fechamento da fatura (0 = não configurado)
  diaVencimento: 0,    // dia de vencimento da fatura (0 = não configurado)
  dismissedInvoiceAlerts: [], // alertKeys dispensados: ["cardId-YYYY-MM", ...]
  lastBackupDate: 0,          // timestamp Unix do último backup exportado
  lastAutoSnapshot: '',       // 'YYYY-MM-DD' do último snapshot automático (gate 1x/dia)
};

// ─── SNAPSHOTS AUTOMÁTICOS ────────────────────────────────────────
// Complementa o backup manual (Config): a cada saveAll, no máx. 1x/dia, grava
// uma cópia em <pastaDeDados>/gastos-backups/gastos-AAAA-MM-DD-HHhMM.json
// (mesmo formato 2 do backup manual — wrapper com checksum SHA-256). Mantém os
// últimos SNAPSHOT_RETENTION_DAYS dias, apagando os mais antigos.
const SNAPSHOT_DIR_NAME       = 'gastos-backups';
const SNAPSHOT_RETENTION_DAYS = 30;

async function _snapshotsDir() {
  const base = appConfig.dataFolderPath || (await window.electronAPI.getDefaultDataPath());
  return window.electronAPI.pathJoin(base, SNAPSHOT_DIR_NAME);
}

function _snapshotStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.toISOString().slice(0,10)}-${p(d.getHours())}h${p(d.getMinutes())}`;
}

// Chamado por saveAll(). Gate por data (1x/dia) via appConfig.lastAutoSnapshot,
// setado ANTES do trabalho assíncrono para evitar corrida entre saves seguidos.
async function _autoSnapshot() {
  if (!isElectron()) return;
  const today = new Date().toISOString().slice(0, 10);
  if (appConfig.lastAutoSnapshot === today) return;
  appConfig.lastAutoSnapshot = today;
  saveConfigToStorage();
  try {
    const content = await _buildBackupFile('');   // formato 2 (com checksum), sem senha
    if (content == null) return;
    const dir  = await _snapshotsDir();
    const file = await window.electronAPI.pathJoin(dir, `gastos-${_snapshotStamp()}.json`);
    await window.electronAPI.writeFile(file, content); // writeFile faz mkdir do dir
    await _pruneOldSnapshots(dir);
    auditLog({ tipo: 'sistema', categoria: 'backup', acao: 'snapshot', ator: 'Sistema', detalhes: { arquivo: `gastos-${_snapshotStamp()}.json`, lancamentos: expenses.length } });
  } catch (e) {
    auditLog({ tipo: 'erro', categoria: 'backup', acao: 'snapshot-erro', ator: 'Sistema', detalhes: { mensagem: String(e && e.message || e) } });
  }
}

// Cria um snapshot AGORA, ignorando o gate 1x/dia — usado antes de operações
// que trocam o local dos dados (troca de pasta / migração de legado).
async function _snapshotBeforeMigration(motivo = 'migracao') {
  if (!isElectron()) return;
  try {
    const content = await _buildBackupFile('');
    if (content == null) return;
    const dir  = await _snapshotsDir();
    const safe = String(motivo).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const file = await window.electronAPI.pathJoin(dir, `gastos-pre-${safe}-${_snapshotStamp()}.json`);
    await window.electronAPI.writeFile(file, content);
    await _pruneOldSnapshots(dir);
  } catch { /* não-fatal */ }
}

// Apaga snapshots com mais de SNAPSHOT_RETENTION_DAYS dias (data no nome).
async function _pruneOldSnapshots(dir) {
  const list = await window.electronAPI.listDir(dir);
  if (!Array.isArray(list)) return;
  const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 86400000;
  for (const f of list) {
    const m = f.name.match(/gastos-(?:pre-[a-z0-9-]+-)?(\d{4})-(\d{2})-(\d{2})-\d{2}h\d{2}\.json$/i);
    if (!m) continue;
    const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    if (t < cutoff) {
      const p = await window.electronAPI.pathJoin(dir, f.name);
      await window.electronAPI.deleteFile(p);
    }
  }
}

// ─── LOG DE AUDITORIA (JSONL) ─────────────────────────────────────
// Grava um evento por linha em <pastaDeDados>/gastos-logs/log-AAAA-MM-DD.jsonl.
// Auditoria financeira (ações do usuário) + debug (erros/sistema). Fire-and-forget,
// serializado numa fila (_logQueue) para não intercalar escritas concorrentes.
// Nunca grava segredos: _scrubDeep mascara strings e apaga chaves de token/secret.
// Retenção: LOG_RETENTION_DAYS dias (prune 1x/dia). "ator" = pessoa do lançamento
// quando aplicável (o app não tem login) ou 'Sistema'/'Bot'.
const LOG_DIR_NAME       = 'gastos-logs';
const LOG_RETENTION_DAYS = 90;
let _logQueue        = Promise.resolve(); // serializa os appends
let _logsPrunedDay   = '';                // gate do prune (1x/dia)

async function _logsDir() {
  const base = appConfig.dataFolderPath || (await window.electronAPI.getDefaultDataPath());
  return window.electronAPI.pathJoin(base, LOG_DIR_NAME);
}

// Remove recursivamente qualquer valor sensível antes de gravar: scrubSecrets em
// strings + apaga chaves conhecidas de credencial (token/secret/senha/password).
function _scrubDeep(val, depth = 0) {
  if (depth > 6) return '[…]';
  if (typeof val === 'string') return scrubSecrets(val);
  if (Array.isArray(val)) return val.slice(0, 200).map(v => _scrubDeep(v, depth + 1));
  if (val && typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val)) {
      if ((typeof SECRET_CONFIG_KEYS !== 'undefined' && SECRET_CONFIG_KEYS.includes(k)) ||
          /token|secret|senha|password|pass/i.test(k)) { out[k] = '***'; continue; }
      out[k] = _scrubDeep(val[k], depth + 1);
    }
    return out;
  }
  return val;
}

// Registra um evento de auditoria/debug. Fire-and-forget — nunca lança nem trava a
// UI. entry: { tipo, categoria, acao, ator?, detalhes?, antes?, depois? }.
function auditLog(entry) {
  try {
    if (!isElectron() || !entry) return; // modo web: sem FS (limitação conhecida)
    const rec = {
      timestamp: new Date().toISOString(),
      tipo:      entry.tipo      || 'sistema',
      categoria: entry.categoria || 'sistema',
      acao:      entry.acao      || 'evento',
      ator:      entry.ator      || 'Sistema',
    };
    if (entry.detalhes !== undefined) rec.detalhes = _scrubDeep(entry.detalhes);
    if (entry.antes    !== undefined) rec.antes    = _scrubDeep(entry.antes);
    if (entry.depois   !== undefined) rec.depois   = _scrubDeep(entry.depois);
    const line = JSON.stringify(rec) + '\n';
    const day  = rec.timestamp.slice(0, 10);
    _logQueue = _logQueue.then(async () => {
      const dir  = await _logsDir();
      const file = await window.electronAPI.pathJoin(dir, `log-${day}.jsonl`);
      await window.electronAPI.appendFile(file, line);
      if (_logsPrunedDay !== day) { _logsPrunedDay = day; await _pruneOldLogs(dir); }
    }).catch(() => {});
  } catch { /* nunca propaga */ }
}

// Snapshot compacto de um lançamento para os campos antes/depois do log.
function _expLogSnapshot(e) {
  if (!e) return null;
  return {
    id: e.id, descricao: e.descricao, valor: e.valor, categoria: e.categoria,
    pessoa: e.pessoa, data: e.data, metodo: e.metodo || '', cardId: e.cardId || null,
    mesCompetencia: e.mesCompetencia, origem: e.origem || 'manual',
    ...(e.pagoPor ? { pagoPor: e.pagoPor } : {}),
  };
}

// Apaga logs com mais de LOG_RETENTION_DAYS dias (data no nome do arquivo).
async function _pruneOldLogs(dir) {
  try {
    const list = await window.electronAPI.listDir(dir);
    if (!Array.isArray(list)) return;
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400000;
    for (const f of list) {
      const m = f.name.match(/^log-(\d{4})-(\d{2})-(\d{2})\.jsonl$/i);
      if (!m) continue;
      const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
      if (t < cutoff) {
        const p = await window.electronAPI.pathJoin(dir, f.name);
        await window.electronAPI.deleteFile(p);
      }
    }
  } catch { /* não-fatal */ }
}

const _snapStampOf = n => ((n.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})h(\d{2})/) || []).slice(1).join('')) || '';

// Lista os snapshots automáticos na aba Config (data + nº de lançamentos + restaurar).
async function renderAutoBackups() {
  const el = document.getElementById('auto-backups-list');
  if (!el) return;
  if (!isElectron()) { el.innerHTML = '<div style="font-size:12px;color:var(--muted)">Disponível apenas no app instalado.</div>'; return; }
  el.innerHTML = '<div style="font-size:12px;color:var(--muted)">Carregando…</div>';
  try {
    const dir  = await _snapshotsDir();
    const list = await window.electronAPI.listDir(dir);
    const snaps = (list || [])
      .filter(f => /^gastos-.*\.json$/i.test(f.name) && _snapStampOf(f.name))
      .sort((a, b) => _snapStampOf(b.name).localeCompare(_snapStampOf(a.name)));
    if (!snaps.length) {
      el.innerHTML = '<div style="font-size:12px;color:var(--muted)">Nenhum snapshot automático ainda. Um é criado no primeiro salvamento de cada dia.</div>';
      return;
    }
    const rows = [];
    for (const f of snaps) {
      const p = await window.electronAPI.pathJoin(dir, f.name);
      let count = '?', pre = /gastos-pre-/i.test(f.name);
      try {
        const w = JSON.parse(await window.electronAPI.readFile(p));
        const payload = w && w.payload ? w.payload : w;
        count = Array.isArray(payload?.expenses) ? payload.expenses.length : '?';
      } catch {}
      const m = f.name.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})h(\d{2})/);
      const label = m ? `${m[3]}/${m[2]}/${m[1]} às ${m[4]}h${m[5]}` : f.name;
      rows.push(`
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 2px;border-bottom:1px solid var(--border)">
          <div style="font-size:12px;min-width:0">
            <strong>${escapeHtml(label)}</strong>${pre ? ' <span class="badge" style="background:var(--warn-soft);color:var(--warn)">pré-migração</span>' : ''}
            <div style="font-size:11px;color:var(--muted)">🧾 ${count} lançamento(s)</div>
          </div>
          <button class="btn btn-secondary" style="font-size:11px;padding:4px 10px;flex-shrink:0" data-snap="${escapeHtml(f.name)}" onclick="_restoreSnapshot(this.dataset.snap)" title="Pré-visualiza e restaura este snapshot">⟲ Restaurar</button>
        </div>`);
    }
    el.innerHTML = `<div style="font-size:11px;color:var(--muted);margin-bottom:6px">${snaps.length} snapshot(s) · mantidos por ${SNAPSHOT_RETENTION_DAYS} dias</div>` + rows.join('');
  } catch { el.innerHTML = '<div style="font-size:12px;color:var(--danger)">Erro ao listar snapshots.</div>'; }
}

// Restaura um snapshot automático — reusa o fluxo de importação (preview +
// verificação de checksum + snapshot de segurança pré-restauração).
async function _restoreSnapshot(name) {
  if (!isElectron() || !name) return;
  try {
    const dir = await _snapshotsDir();
    const p   = await window.electronAPI.pathJoin(dir, name);
    const content = await window.electronAPI.readFile(p);
    if (!content) { notify('Não foi possível ler o snapshot.', 'err'); return; }
    _handleImportContent(content);
  } catch { notify('Falha ao abrir o snapshot.', 'err'); }
}

const SLOT_COLORS_LIGHT = ['#2E5480', '#7A3F5E', '#235C3F', '#5B4FAA'];
const SLOT_COLORS_DARK  = ['#7EAACB', '#C47EA0', '#5BAA7D', '#9E95E0'];
function slotColors() {
  return document.documentElement.getAttribute('data-theme') === 'dark'
    ? SLOT_COLORS_DARK : SLOT_COLORS_LIGHT;
}
const METHOD_ICONS  = { 'Débito': '💳', 'Crédito': '💳', 'Pix': '⚡', 'Dinheiro': '💵', 'Vale': '🎫' };
const CARD_COLORS   = ['#344B62','#2E5480','#7A3F5E','#235C3F','#BA7517','#D85A30','#7F77DD','#A0522D'];

// ─── ELECTRON BRIDGE ─────────────────────────────────────────────
const isElectron = () => typeof window.electronAPI !== 'undefined';

// ─── HELPERS ─────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── VALIDAÇÃO/SANITIZAÇÃO DE DADOS EXTERNOS ─────────────────────
// Aplicada a dados vindos de fora do controle do usuário: sync (Google Sheets),
// bot do Telegram e importação de fatura (.xls). Complementa o escapeHtml() (que
// protege o DOM) prevenindo que valores/datas/strings malformados quebrem o app.
const VALIDATION = {
  valorMax: 1000000,   // R$ 1.000.000 — teto plausível para um gasto
  descMax:  200,       // caracteres na descrição
  msgMax:   1000,      // caracteres na mensagem original (Telegram)
  nameMax:  80,        // nome de pessoa
  catMax:   80,        // nome de categoria
  yearMin:  2000,      // datas anteriores são consideradas absurdas
  yearMax:  2100,
};

// Remove caracteres de controle, colapsa espaços, trunca no limite. Nunca lança.
function sanitizeText(s, max) {
  if (s == null) return '';
  const out = String(s).replace(/[\x00-\x1F\x7F]+/g, ' ').replace(/\s+/g, ' ').trim();
  return out.length > max ? out.slice(0, max) : out;
}

// Retorna um número monetário válido (0..valorMax, 2 casas) ou null se inválido/fora da faixa.
function sanitizeMoney(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > VALIDATION.valorMax) return null;
  return Math.round(n * 100) / 100;
}

// Valida uma data 'DD/MM/YYYY' (existe de fato e ano plausível). Retorna normalizada ou null.
function sanitizeDateBR(d) {
  if (typeof d !== 'string') return null;
  const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = +m[1], mon = +m[2], yr = +m[3];
  if (yr < VALIDATION.yearMin || yr > VALIDATION.yearMax || mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  const dt = new Date(yr, mon - 1, day);
  if (dt.getFullYear() !== yr || dt.getMonth() !== mon - 1 || dt.getDate() !== day) return null; // ex: 31/02
  return `${String(day).padStart(2, '0')}/${String(mon).padStart(2, '0')}/${yr}`;
}

// Coerções defensivas para JSON parseável mas com tipos errados (arquivo corrompido).
const asArray  = v => Array.isArray(v) ? v : [];
const asObject = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};

const fmt          = v => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today        = () => new Date().toISOString().slice(0, 10);
const parseDateStr = d => { const [day, mon, yr] = d.split('/'); return `${yr}-${mon}-${day}`; };

function getPersons() {
  if (currentContext === 'empresa') return [appConfig.companyName];
  return [appConfig.p1Name, appConfig.p2Name, appConfig.coupleName];
}

function getPersonColors() {
  const keys = [appConfig.p1Name, appConfig.p2Name, appConfig.coupleName, appConfig.companyName];
  const map  = {};
  keys.forEach((name, i) => { if (name) map[name] = slotColors()[i] || '#888'; });
  return map;
}

function personColor(name) { return getPersonColors()[name] || '#888'; }

function formatMonth(ym) {
  const [yr, mo] = ym.split('-');
  return ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][parseInt(mo)-1] + ' ' + yr;
}

function notify(msg, type = 'info') {
  const el = document.getElementById('notif');
  el.textContent = msg; el.className = 'notif show ' + type;
  setTimeout(() => el.className = 'notif', 3000);
}

// ─── PERSISTENCE ─────────────────────────────────────────────────
async function resolveDataFilePath() {
  if (dataFilePath) return dataFilePath;
  if (isElectron()) {
    const folder = appConfig.dataFolderPath;
    const base   = folder || (await window.electronAPI.getDefaultDataPath());
    dataFilePath = await window.electronAPI.pathJoin(base, 'gastos.json');
  }
  // Expose for main process (to open the folder in Explorer)
  window.__getDataPath = () => dataFilePath;
  return dataFilePath;
}

async function saveAll() {
  const data = { expenses, customCats, budgets, fixedExpenses, cards, monthGoals, merchantMap, acertos, faturaPagamentos, deletedIds: [...deletedExpenseIds] };
  if (isElectron()) {
    const filePath = await resolveDataFilePath();
    const ok = await window.electronAPI.writeFile(filePath, JSON.stringify(data, null, 2));
    if (!ok) { notify('Erro ao salvar arquivo de dados!', 'err'); auditLog({ tipo: 'erro', categoria: 'sistema', acao: 'escrita-arquivo', ator: 'Sistema', detalhes: { arquivo: 'gastos.json' } }); }
    _autoSnapshot(); // snapshot automático 1x/dia (não bloqueia o save)
  } else {
    try {
      localStorage.setItem('gc_expenses',    JSON.stringify(expenses));
      localStorage.setItem('gc_customcats', JSON.stringify(customCats));
      localStorage.setItem('gc_budgets',    JSON.stringify(budgets));
      localStorage.setItem('gc_fixed',      JSON.stringify(fixedExpenses));
      localStorage.setItem('gc_monthgoals', JSON.stringify(monthGoals));
      localStorage.setItem('gc_cards',       JSON.stringify(cards));
      localStorage.setItem('gc_merchantmap', JSON.stringify(merchantMap));
      localStorage.setItem('gc_acertos',    JSON.stringify(acertos));
      localStorage.setItem('gc_faturapag',  JSON.stringify(faturaPagamentos));
    } catch { notify('Erro ao salvar. Armazenamento cheio?', 'err'); }
  }
}

async function loadAll() {
  if (isElectron()) {
    const filePath = await resolveDataFilePath();
    const content  = await window.electronAPI.readFile(filePath);
    if (content) {
      try {
        const data    = JSON.parse(content);
        // asArray/asObject: um arquivo parseável mas com tipo errado (ex: expenses:"x")
        // não deve virar estado inválido que quebra map/filter/unshift depois.
        expenses      = asArray(data.expenses);
        customCats    = asArray(data.customCats);
        budgets       = asArray(data.budgets);
        fixedExpenses = asArray(data.fixedExpenses);
        deletedExpenseIds = new Set(asArray(data.deletedIds).map(String));
        cards       = asArray(data.cards);
        monthGoals  = asArray(data.monthGoals);
        merchantMap = asObject(data.merchantMap);
        acertos     = asArray(data.acertos);
        faturaPagamentos = asArray(data.faturaPagamentos);
      } catch { expenses = []; customCats = []; budgets = []; fixedExpenses = []; monthGoals = []; cards = []; merchantMap = {}; acertos = []; faturaPagamentos = []; }
    }
  } else {
    try {
      expenses      = asArray(JSON.parse(localStorage.getItem('gc_expenses')    || '[]'));
      customCats    = asArray(JSON.parse(localStorage.getItem('gc_customcats')  || '[]'));
      budgets       = asArray(JSON.parse(localStorage.getItem('gc_budgets')     || '[]'));
      fixedExpenses = asArray(JSON.parse(localStorage.getItem('gc_fixed')       || '[]'));
      monthGoals    = asArray(JSON.parse(localStorage.getItem('gc_monthgoals')  || '[]'));
      cards         = asArray(JSON.parse(localStorage.getItem('gc_cards')        || '[]'));
      merchantMap   = asObject(JSON.parse(localStorage.getItem('gc_merchantmap')  || '{}'));
      acertos       = asArray(JSON.parse(localStorage.getItem('gc_acertos')      || '[]'));
      faturaPagamentos = asArray(JSON.parse(localStorage.getItem('gc_faturapag') || '[]'));
    } catch { expenses = []; customCats = []; budgets = []; fixedExpenses = []; monthGoals = []; cards = []; merchantMap = {}; acertos = []; faturaPagamentos = []; }
  }
}

// Segredos criptografados via safeStorage (Electron): o localStorage guarda só
// as versões cifradas (tgTokenEnc/sheetsSecretEnc), nunca o texto puro. O texto
// puro fica só em memória (appConfig.tgToken/sheetsSecret) para uso em runtime.
// Pares [chave em texto puro, chave cifrada]:
const SECRET_KEY_PAIRS = [['tgToken', 'tgTokenEnc'], ['sheetsSecret', 'sheetsSecretEnc']];

function saveConfigToStorage() {
  const toStore = { ...appConfig };
  // Só remove o texto puro se a criptografia estiver disponível (Electron sem
  // fallback). Em modo web ou fallback, mantém texto puro (limitação conhecida).
  if (isElectron() && !appConfig.secretsPlaintextFallback) {
    SECRET_KEY_PAIRS.forEach(([plainKey]) => delete toStore[plainKey]);
  }
  localStorage.setItem('gc_config', JSON.stringify(toStore));
}

// Re-encripta os segredos em texto puro atuais para o cache cifrado em appConfig.
// Retorna true se a criptografia está disponível; marca secretsPlaintextFallback caso não.
async function refreshSecretCache() {
  if (!isElectron()) { appConfig.secretsPlaintextFallback = true; return false; }
  let available = true;
  for (const [plainKey, encKey] of SECRET_KEY_PAIRS) {
    const plain = appConfig[plainKey] || '';
    if (!plain) { appConfig[encKey] = ''; continue; }
    try {
      const res = await window.electronAPI.encryptSecret(plain);
      if (res && res.available && res.value != null) {
        appConfig[encKey] = res.value;
      } else { available = false; }
    } catch { available = false; }
  }
  appConfig.secretsPlaintextFallback = !available;
  if (!available && !appConfig._fallbackWarned) {
    appConfig._fallbackWarned = true;
    notify('Criptografia do sistema indisponível — credenciais salvas sem criptografia.', 'warn');
  }
  return available;
}

// Ao iniciar: descriptografa os segredos cifrados para memória e migra tokens
// em texto puro de versões anteriores para o formato criptografado.
async function hydrateSecrets() {
  if (!isElectron()) return; // web: segredos ficam em texto puro no localStorage
  const hadPlaintextStored = SECRET_KEY_PAIRS.some(([plainKey]) => !!appConfig[plainKey]);
  for (const [plainKey, encKey] of SECRET_KEY_PAIRS) {
    // Se já veio texto puro (versão antiga), preserva para migrar; senão descriptografa.
    if (!appConfig[plainKey] && appConfig[encKey]) {
      try {
        const res = await window.electronAPI.decryptSecret(appConfig[encKey]);
        appConfig[plainKey] = (res && res.value != null) ? res.value : '';
      } catch { appConfig[plainKey] = ''; }
    }
  }
  if (hadPlaintextStored) {
    // Migração: cifra os tokens em texto puro e regrava (remove o texto puro do storage).
    const ok = await refreshSecretCache();
    saveConfigToStorage();
    if (ok) addLog('🔒 Credenciais migradas para armazenamento criptografado.', 'info');
  } else {
    await refreshSecretCache(); // popula o cache cifrado p/ saves futuros
  }
}

// ─── CONFIG ──────────────────────────────────────────────────────
function loadConfig() {
  try {
    const stored     = JSON.parse(localStorage.getItem('gc_config') || '{}');
    const isFirstRun = !stored.p1Name;
    appConfig = { ...DEFAULT_CONFIG, ...stored };

    if (isFirstRun) {
      // Migrate old 'Eu' to new default name on first run
      saveConfigToStorage();
      let changed = false;
      expenses.forEach(e    => { if (e.pessoa === 'Eu') { e.pessoa = appConfig.p1Name; changed = true; } });
      fixedExpenses.forEach(f => { if (f.pessoa === 'Eu') { f.pessoa = appConfig.p1Name; changed = true; } });
      if (changed) saveAll();
    }
  } catch { appConfig = { ...DEFAULT_CONFIG }; }
  currentPerson = appConfig.p1Name;
}

async function saveConfigSettings() {
  const val = id => document.getElementById(id)?.value.trim() || '';
  const newP1      = val('cfg-p1')      || DEFAULT_CONFIG.p1Name;
  const newP2      = val('cfg-p2')      || DEFAULT_CONFIG.p2Name;
  const newCouple  = val('cfg-couple')  || DEFAULT_CONFIG.coupleName;
  const newCompany = val('cfg-company') || DEFAULT_CONFIG.companyName;
  // Os campos tg-token/tg-group foram removidos da UI (bot interno desativado —
  // configuração fica no Render). Se ausentes, preserva o valor já armazenado.
  const newToken   = document.getElementById('tg-token') ? val('tg-token') : (appConfig.tgToken || '');
  const newGroup   = document.getElementById('tg-group') ? val('tg-group') : (appConfig.tgGroup || '');

  const oldP1     = appConfig.p1Name;
  const oldP2     = appConfig.p2Name;
  const oldCouple = appConfig.coupleName;

  const newAppsScript  = val('cfg-apps-script');
  const newFechamento  = parseInt(document.getElementById('cfg-fechamento')?.value) || 0;
  const newVencimento  = parseInt(document.getElementById('cfg-vencimento')?.value) || 0;
  const oldFechamento  = appConfig.diaFechamento;
  const oldVencimento  = appConfig.diaVencimento;
  appConfig = {
    ...appConfig,
    p1Name: newP1, p2Name: newP2, coupleName: newCouple, companyName: newCompany,
    tgToken: newToken, tgGroup: newGroup,
    appsScriptUrl: newAppsScript,
    sheetsSecret: val('cfg-sheets-secret'),
    diaFechamento: newFechamento,
    diaVencimento: newVencimento,
  };
  await refreshSecretCache(); // cifra tgToken/sheetsSecret antes de persistir
  saveConfigToStorage();
  // Se as datas do cartão mudaram, recalcula competência de todos os lançamentos de crédito
  if (newFechamento !== oldFechamento || newVencimento !== oldVencimento) recalcularCompetencias();

  // Migrate person names in all data
  let changed = false;
  const migrate = arr => arr.forEach(e => {
    if (e.pessoa === oldP1 && newP1 !== oldP1)               { e.pessoa = newP1; changed = true; }
    else if (e.pessoa === oldP2 && newP2 !== oldP2)          { e.pessoa = newP2; changed = true; }
    else if (e.pessoa === oldCouple && newCouple !== oldCouple) { e.pessoa = newCouple; changed = true; }
  });
  migrate(expenses); migrate(fixedExpenses);
  if (changed) saveAll();

  currentPerson = newP1;
  renderCfgForm();
  refreshAllDynamicSelects();
  updateMetrics(); renderCharts(); renderRecent(); renderList(); renderDivisao(); renderBudgets();
  notify('Configuração salva!', 'ok');
  startSheetsSync(); // restart sync with new URL if changed
}

async function changeDataFolder() {
  if (!isElectron()) { notify('Função disponível apenas no app instalado.', 'warn'); return; }
  const folder = await window.electronAPI.selectFolder();
  if (!folder) return;

  // Protege os dados atuais antes de trocar o local (snapshot na pasta atual).
  await _snapshotBeforeMigration('troca-de-pasta');

  const newPath = await window.electronAPI.pathJoin(folder, 'gastos.json');
  const exists  = await window.electronAPI.fileExists(newPath);

  if (exists) {
    const load = confirm(`Encontrado gastos.json em:\n${folder}\n\nCarregar os dados deste arquivo? (substitui os dados atuais)`);
    if (load) {
      appConfig.dataFolderPath = folder;
      dataFilePath = newPath;
      saveConfigToStorage();
      await loadAll();
      renderCfgForm();
      updateMetrics(); renderCharts(); renderRecent(); renderList();
      renderBudgets(); renderBudgetAlerts(); renderDivisao();
      refreshAllDynamicSelects();
      notify('Dados carregados da nova pasta!', 'ok');
      return;
    }
  }

  // Save current data to new location and switch
  appConfig.dataFolderPath = folder;
  dataFilePath = newPath;
  saveConfigToStorage();
  await saveAll();
  renderCfgForm();
  notify('Pasta de dados alterada! Dados salvos na nova localização.', 'ok');
}

function renderCfgForm() {
  const set = (id, val) => { const e = document.getElementById(id); if (e) e.value = val; };
  set('cfg-p1',      appConfig.p1Name);
  set('cfg-p2',      appConfig.p2Name);
  set('cfg-couple',  appConfig.coupleName);
  set('cfg-apps-script', appConfig.appsScriptUrl || '');
  set('cfg-sheets-secret', appConfig.sheetsSecret || '');
  set('cfg-company', appConfig.companyName);
  set('tg-token',    appConfig.tgToken || '');
  set('tg-group',    appConfig.tgGroup || '');
  set('cfg-fechamento', appConfig.diaFechamento || '');
  set('cfg-vencimento', appConfig.diaVencimento || '');

  // Show current data file path
  const pathEl = document.getElementById('cfg-data-path');
  if (pathEl) {
    pathEl.textContent = dataFilePath
      ? dataFilePath
      : (isElectron() ? 'Resolvendo...' : 'localStorage (modo browser)');
  }

  renderCardsList();

  // Backup card info
  const backupInfoEl = document.getElementById('backup-info');
  if (backupInfoEl) {
    const ts = appConfig.lastBackupDate;
    if (ts) {
      const d         = new Date(ts);
      const dateStr   = d.toLocaleDateString('pt-BR');
      const timeStr   = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const daysSince = Math.floor((Date.now() - ts) / 86400000);
      const staleWarn = daysSince > 30
        ? `<div style="color:var(--warn);margin-top:5px;font-size:11px">⚠️ Último backup há ${daysSince} dias — considere exportar um novo.</div>`
        : '';
      backupInfoEl.innerHTML = `<span>Último backup: <strong>${dateStr} às ${timeStr}</strong></span>${staleWarn}`;
    } else {
      backupInfoEl.innerHTML = '<span style="color:var(--muted)">Nenhum backup exportado ainda.</span>';
    }
  }
}

function getConfig() { return appConfig; }

async function renderAppVersionInfo() {
  if (!isElectron()) return;
  const version = await window.electronAPI.getAppVersion();
  if (version) {
    const badge = document.getElementById('app-version-badge');
    if (badge) badge.textContent = `v${version}`;
    const aboutVersionEl = document.getElementById('about-version');
    if (aboutVersionEl) aboutVersionEl.textContent = version;
  }

  const buildDate = await window.electronAPI.getBuildDate();
  const rowEl  = document.getElementById('about-build-date-row');
  const dateEl = document.getElementById('about-build-date');
  if (rowEl && dateEl) {
    if (buildDate) {
      const d = new Date(buildDate);
      dateEl.textContent = `${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
      rowEl.style.display = '';
    } else {
      rowEl.style.display = 'none';
    }
  }
}

function checkForUpdatesFromUI() {
  if (!isElectron()) { notify('Função disponível apenas no app instalado.', 'warn'); return; }
  notify('Verificando atualizações...', 'info');
  window.electronAPI.checkForUpdates();
}

function refreshAllDynamicSelects() {
  renderPersonPills();
  populateBudgetCatSelect();
  populateFixedCatSelect();
  populateFixedPersonSelect();
}

// ─── MONTH SELECTOR ──────────────────────────────────────────────
function buildMonthSelector() {
  const sel = document.getElementById('month-sel');
  if (!sel) return;
  const now  = new Date();
  const yr   = now.getFullYear();
  const mo   = now.getMonth();
  const names = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const opts  = [];
  for (let y = yr - 1; y <= yr + 1; y++) {
    for (let m = 0; m < 12; m++) {
      const val  = `${y}-${String(m+1).padStart(2,'0')}`;
      const sel_ = (y === yr && m === mo) ? ' selected' : '';
      opts.push(`<option value="${val}"${sel_}>${names[m]} ${y}</option>`);
    }
  }
  sel.innerHTML = opts.join('');
  currentMonth = `${yr}-${String(mo+1).padStart(2,'0')}`;
}

// ─── CONTEXT SWITCHER ────────────────────────────────────────────
function switchContext(ctx) {
  currentContext = ctx;
  document.querySelectorAll('.ctx-btn').forEach(b => b.classList.toggle('active', b.dataset.ctx === ctx));
  currentPerson = getPersons()[0];
  refreshAllDynamicSelects();
  updateMetrics(); renderCharts(); renderRecent(); renderList();
  renderBudgets(); renderBudgetAlerts(); renderDivisao();
}

// ─── TABS ─────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab) tab.classList.add('active');
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');
  if (name === 'dashboard')   { updateMetrics(); renderCharts(); renderBudgetAlerts(); renderInvoiceAlerts(); renderFaturas(); renderRecent(); }
  if (name === 'lancamentos') {
    // Reset all filter/sort state every time the tab is opened (per spec)
    _listFilters    = { pessoa: null, dateFrom: '', dateTo: '', valorMin: null, valorMax: null, metodo: null, cardId: null, origem: null };
    _listSort       = { field: 'data', dir: 'desc' };
    _advFiltersOpen = false;
    activeFilter    = null;
    const si = document.getElementById('search-input');
    if (si) si.value = '';
    const af  = document.getElementById('advanced-filters');
    const tog = document.getElementById('adv-filter-toggle');
    if (af)  af.style.display  = 'none';
    if (tog) tog.textContent   = '⚙ Filtros ▾';
    renderList(); renderCatFilters();
  }
  if (name === 'categorias')  { renderCatGrid(); renderMerchantMap(); populateMerchantCatSelect(); }
  if (name === 'orcamento')   renderBudgets();
  if (name === 'fixas')       { populateFixedCatSelect(); populateFixedPersonSelect(); renderFixedList(); }
  if (name === 'divisao')     renderDivisao();
  if (name === 'relatorios')  { initReportDates(); renderEvolutionChart(); }
  if (name === 'config')      { renderCfgForm(); renderAutoBackups(); }
}

function onMonthChange() {
  currentMonth = document.getElementById('month-sel').value;
  _autoGenerateFixed();
  updateMetrics(); renderCharts(); renderRecent(); renderList();
  renderBudgets(); renderBudgetAlerts(); renderDivisao(); renderEvolutionChart();
}

// ─── PERSON PILLS ─────────────────────────────────────────────────
function renderPersonPills() {
  const container = document.getElementById('person-pills');
  if (!container) return;
  const persons = getPersons();
  if (!persons.includes(currentPerson)) currentPerson = persons[0];
  container.innerHTML = persons.map(p =>
    `<button class="pill ${p === currentPerson ? 'active' : ''}" onclick="selectPerson('${escapeHtml(p)}')">${escapeHtml(p)}</button>`
  ).join('');
  const lbl1 = document.getElementById('split-lbl-p1');
  const lbl2 = document.getElementById('split-lbl-p2');
  if (lbl1) lbl1.textContent = `% ${appConfig.p1Name}`;
  if (lbl2) lbl2.textContent = `% ${appConfig.p2Name}`;
}

function selectPerson(name) {
  currentPerson = name;
  renderPersonPills();
  updateSplitPreview();
}

// ─── COLOR PICKER ─────────────────────────────────────────────────
document.querySelectorAll('.color-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.color-opt').forEach(x => x.classList.remove('selected'));
    opt.classList.add('selected');
    selectedColor = opt.dataset.color;
  });
});

// ─── EMOJI PICKER ─────────────────────────────────────────────────
const EMOJI_GROUPS = [
  { label: 'Alimentação',    emojis: ['🍕','🍔','🌮','🥗','🍣','🍜','🥩','🍳','🥞','🍞','🧁','🍰','🍩','🍪','🍦','🫕','🥘','🍱','🥐','🧆'] },
  { label: 'Bebidas',        emojis: ['☕','🍵','🧃','🥤','🍺','🍷','🥛','🧋','🍾','🫖','🧉'] },
  { label: 'Mercado',        emojis: ['🛒','🧺','🧴','🧼','🧻','🪣','🛍️','🥦','🥕','🧅','🥚','🫙'] },
  { label: 'Transporte',     emojis: ['🚗','🚕','🏎️','🚌','✈️','🚲','🛵','🏍️','⛽','🚊','🚢','🛻','🚁','🛺','⛽','🗺️'] },
  { label: 'Saúde',          emojis: ['💊','💉','🩺','🏥','🩹','🦷','🩻','🏋️','🧘','🫀','🩸','🧬','🔬','😷','🩼'] },
  { label: 'Casa',           emojis: ['🏠','🏡','🔧','🔨','🪛','🧹','🛁','🚿','🛋️','🪟','🚪','🔑','🪴','💡','🔌','🧰','🪜','🛏️','🧺','🪥'] },
  { label: 'Roupas & Beleza',emojis: ['👗','👔','👟','👠','👜','💄','💅','💍','👑','🕶️','⌚','🧴','🪮','🧣','🧤','👒','🩱','🧢'] },
  { label: 'Lazer',          emojis: ['🎮','🎲','🎬','🎵','🎸','🎧','⚽','🏀','🎾','🏊','🎣','🎳','🎯','🏕️','🎡','🎭','🎨','🧩','🎻','♟️'] },
  { label: 'Pets',           emojis: ['🐕','🐈','🐟','🐇','🐹','🦜','🐠','🦴','🐾','🐾','🦮','🐈‍⬛','🐿️'] },
  { label: 'Educação',       emojis: ['📚','📖','✏️','📓','🎓','🏫','🔬','🧪','📐','📝','🖊️','📏','🖍️','🗒️'] },
  { label: 'Tech',           emojis: ['📱','💻','🖥️','⌨️','🖱️','📷','📹','🔋','🎙️','📡','🖨️','💾','📀','🎛️'] },
  { label: 'Finanças',       emojis: ['💰','💳','💵','💸','🏦','📊','📈','💼','🏢','🪙','🤑','🏧','📉','🧾'] },
  { label: 'Outros',         emojis: ['🎁','🎀','🎊','🎉','🔔','📦','🧲','🔐','📬','⭐','❤️','✅','🌟','🔖','🗑️','⚙️','🔍','🌍'] },
];

let _emojiPickerTarget = null;
let _emojiPickerBuilt  = false;

function _buildEmojiPicker() {
  if (_emojiPickerBuilt) return;
  document.getElementById('emoji-picker').innerHTML = EMOJI_GROUPS.map(g =>
    `<div class="emoji-group-label">${g.label}</div><div class="emoji-grid">${
      g.emojis.map(e => `<button class="emoji-btn" onclick="selectEmoji('${e}')">${e}</button>`).join('')
    }</div>`
  ).join('');
  _emojiPickerBuilt = true;
}

function openEmojiPicker(inputId, btnId) {
  _buildEmojiPicker();
  _emojiPickerTarget = { inputId, btnId };
  const btn    = document.getElementById(btnId);
  const picker = document.getElementById('emoji-picker');
  const rect   = btn.getBoundingClientRect();
  picker.style.top  = (rect.bottom + 4) + 'px';
  picker.style.left = rect.left + 'px';
  picker.style.display = 'block';
  requestAnimationFrame(() => {
    const pr = picker.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8) picker.style.left = Math.max(8, window.innerWidth - 8 - pr.width) + 'px';
    if (pr.bottom > window.innerHeight - 8) picker.style.top = Math.max(8, rect.top - pr.height - 4) + 'px';
  });
}

function closeEmojiPicker() {
  document.getElementById('emoji-picker').style.display = 'none';
  _emojiPickerTarget = null;
}

function selectEmoji(emoji) {
  if (!_emojiPickerTarget) return;
  document.getElementById(_emojiPickerTarget.inputId).value = emoji;
  const btn = document.getElementById(_emojiPickerTarget.btnId);
  if (btn) btn.textContent = emoji;
  closeEmojiPicker();
}

document.addEventListener('click', e => {
  const picker = document.getElementById('emoji-picker');
  if (!picker || picker.style.display !== 'block') return;
  if (!picker.contains(e.target) && !e.target.closest('.emoji-trigger')) closeEmojiPicker();
});

// ─── INSTALLMENT / SHARED TOGGLES ────────────────────────────────
function toggleInstallment() {
  document.getElementById('installment-fields').style.display =
    document.getElementById('chk-installment').checked ? 'grid' : 'none';
}

function toggleShared() {
  document.getElementById('shared-fields').style.display =
    document.getElementById('chk-shared').checked ? 'block' : 'none';
  renderPersonPills();
  updateSplitPreview();
}

function updateSplitPreview() {
  const text  = document.getElementById('add-msg')?.value || '';
  const r     = text ? classifyInput(text) : null;
  const total = r?.valor || 0;
  const me      = parseFloat(document.getElementById('split-pct-me')?.value || 50) / 100;
  const partner = parseFloat(document.getElementById('split-pct-partner')?.value || 50) / 100;
  const el = document.getElementById('split-preview');
  if (el && total > 0)
    el.innerHTML = `${escapeHtml(appConfig.p1Name)}: <strong>${fmt(total*me)}</strong> · ${escapeHtml(appConfig.p2Name)}: <strong>${fmt(total*partner)}</strong>`;
}

// ─── ADD EXPENSE ──────────────────────────────────────────────────
function clearAddForm() {
  document.getElementById('add-msg').value = '';
  document.getElementById('add-preview').style.display = 'none';
  document.getElementById('add-error').style.display   = 'none';
  document.getElementById('chk-installment').checked   = false;
  document.getElementById('chk-shared').checked        = false;
  document.getElementById('installment-fields').style.display = 'none';
  document.getElementById('shared-fields').style.display      = 'none';
}

function classifyInput(text) { return classify(text, customCats); }

function previewAdd() {
  const text = document.getElementById('add-msg').value.trim();
  if (!text) return;
  const r    = classifyInput(text);
  const box  = document.getElementById('add-preview');
  const errEl = document.getElementById('add-error');
  if (!r || r.valor === null) {
    errEl.textContent = '⚠️ Não encontrei um valor. Inclua o valor (ex: R$ 45 ou 45 reais).';
    errEl.style.display = 'block'; box.style.display = 'none'; return;
  }
  errEl.style.display = 'none'; box.style.display = 'block';
  box.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:4px 0">
    <div style="width:32px;height:32px;border-radius:50%;background:${escapeHtml(r.cor)}22;display:flex;align-items:center;justify-content:center;font-size:16px">${r.icone}</div>
    <div style="flex:1">
      <div style="font-size:13px;font-weight:500">${escapeHtml(r.descricao)}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:2px;display:flex;gap:6px">
        <span class="badge" style="background:${escapeHtml(r.cor)}22;color:${escapeHtml(r.cor)}">${escapeHtml(r.categoria)}</span>
        <span>${escapeHtml(currentPerson)}</span>
        ${r.confianca < 20 ? '<span style="color:#f59e0b">⚠️ categoria incerta</span>' : ''}
      </div>
    </div>
    <div style="font-size:14px;font-weight:600;color:var(--danger)">${fmt(r.valor)}</div>
  </div>`;
  updateSplitPreview();
}

function submitAdd() {
  const text = document.getElementById('add-msg').value.trim();
  if (!text) { notify('Digite uma mensagem.', 'err'); return; }
  const r = classifyInput(text);
  if (!r || r.valor === null) {
    document.getElementById('add-error').textContent = '⚠️ Valor não encontrado. Ex: "Mercado 87,50"';
    document.getElementById('add-error').style.display = 'block'; return;
  }
  document.getElementById('add-error').style.display = 'none';
  const method    = document.getElementById('add-method').value;
  const cardId    = document.getElementById('add-card')?.value || null;
  const isInstall = document.getElementById('chk-installment').checked;
  const isShared  = document.getElementById('chk-shared').checked;

  if (isInstall) {
    const total    = parseInt(document.getElementById('inst-total').value)    || 2;
    const current  = parseInt(document.getElementById('inst-current').value)  || 1;
    const totalVal = parseFloat(document.getElementById('inst-total-val').value) || r.valor * total;
    const parcela  = totalVal / total;
    addExpenseObj({ ...r, valor: parcela, pessoa: currentPerson, mensagem: text, metodo: method, cardId,
      installment: { total, current, totalVal, parcela } });
    notify(`Parcela ${current}/${total} adicionada!`, 'ok');
  } else if (isShared) {
    const pctMe      = parseFloat(document.getElementById('split-pct-me').value) / 100;
    const pctPartner = parseFloat(document.getElementById('split-pct-partner').value) / 100;
    addExpenseObj({ ...r, valor: r.valor*pctMe,      pessoa: appConfig.p1Name, mensagem: text, metodo: method, cardId, splitOf: r.valor, splitPct: pctMe*100 });
    addExpenseObj({ ...r, valor: r.valor*pctPartner, pessoa: appConfig.p2Name, mensagem: text, metodo: method, cardId, splitOf: r.valor, splitPct: pctPartner*100 });
    notify('Despesa dividida!', 'ok');
  } else {
    addExpenseObj({ ...r, pessoa: currentPerson, mensagem: text, metodo: method, cardId });
    notify('Gasto adicionado!', 'ok');
  }

  const bar = document.getElementById('add-bar');
  document.getElementById('add-loading').style.display = 'block';
  bar.style.width = '100%';
  setTimeout(() => { document.getElementById('add-loading').style.display='none'; bar.style.width='0'; clearAddForm(); closeAddModal(); }, 400);
}

function testClassifier() {
  const text = document.getElementById('test-input').value.trim();
  if (!text) return;
  const r  = classifyInput(text);
  const el = document.getElementById('test-result');
  if (!r) { el.innerHTML = '<span style="color:var(--danger)">Não foi possível classificar.</span>'; return; }
  el.innerHTML = `<div style="display:flex;align-items:center;gap:8px">
    <span style="font-size:20px">${r.icone}</span>
    <div>
      <div><strong>${escapeHtml(r.descricao)}</strong></div>
      <div style="display:flex;gap:7px;margin-top:3px">
        <span class="badge" style="background:${escapeHtml(r.cor)}22;color:${escapeHtml(r.cor)}">${escapeHtml(r.categoria)}</span>
        ${r.valor !== null ? `<span>Valor: <strong>${fmt(r.valor)}</strong></span>` : '<span style="color:#f59e0b">Sem valor</span>'}
        <span style="color:var(--muted)">confiança: ${r.confianca}%</span>
      </div>
    </div>
  </div>`;
}

// ─── CORE EXPENSE ─────────────────────────────────────────────────
function addExpenseObj({ descricao, valor, categoria, categoriaId, icone, cor, pessoa, mensagem, confianca, metodo, installment, splitOf, splitPct, fixedId, cardId }) {
  // Saneamento defensivo — cobre entrada manual e o bot do Telegram (from/text livres).
  const valorSan = sanitizeMoney(valor);
  if (valorSan === null) { notify('Valor inválido ou fora da faixa — lançamento não adicionado.', 'err'); return; }
  descricao = sanitizeText(descricao, VALIDATION.descMax) || 'Sem descrição';
  categoria = sanitizeText(categoria, VALIDATION.catMax) || 'Outros';
  pessoa    = sanitizeText(pessoa, VALIDATION.nameMax);
  mensagem  = sanitizeText(mensagem, VALIDATION.msgMax);
  const now    = new Date();
  const dataBR = now.toLocaleDateString('pt-BR');
  const novo = {
    id: Date.now() + Math.random(),
    descricao, valor: valorSan,
    categoria, categoriaId, icone, cor,
    pessoa, mensagem, confianca: confianca || 0,
    data: dataBR, ts: now.getTime(),
    metodo: metodo || '',
    cardId: cardId || null,
    mesCompetencia: calcularMesCompetencia(dataBR, metodo || '', cardId || null),
    installment: installment || null, splitOf: splitOf || null, splitPct: splitPct || null,
    fixedId: fixedId || null, contexto: currentContext,
  };
  expenses.unshift(novo);
  auditLog({ tipo: 'acao_usuario', categoria: 'lancamento', acao: 'criar', ator: novo.pessoa || 'Usuário', detalhes: { origem: fixedId ? 'fixa' : 'manual' }, depois: _expLogSnapshot(novo) });
  saveAll(); updateMetrics(); renderFaturas(); renderRecent(); renderList(); renderBudgetAlerts();
}

function deleteExpense(id) {
  if (!confirm('Remover este lançamento?')) return;
  const alvo = expenses.find(e => e.id === id);
  deletedExpenseIds.add(String(id));
  expenses = expenses.filter(e => e.id !== id);
  auditLog({ tipo: 'acao_usuario', categoria: 'lancamento', acao: 'excluir', ator: alvo?.pessoa || 'Usuário', detalhes: { id }, antes: _expLogSnapshot(alvo) });
  saveAll(); updateMetrics(); renderFaturas(); renderRecent(); renderList(); renderCharts(); renderBudgetAlerts();
  notify('Removido.', 'info');
}

// ─── EDIT MODAL ───────────────────────────────────────────────────
function openEdit(id) {
  const e = expenses.find(x => x.id === id);
  if (!e) return;
  document.getElementById('edit-id').value    = id;
  document.getElementById('edit-desc').value  = e.descricao;
  document.getElementById('edit-valor').value = fmtCurrencyInput(e.valor);
  const iso = e.data && e.data.includes('/') ? parseDateStr(e.data) : (e.data || today());
  document.getElementById('edit-data').value  = iso;

  const allPersons = [appConfig.p1Name, appConfig.p2Name, appConfig.coupleName, appConfig.companyName];
  document.getElementById('edit-person').innerHTML = allPersons.map(p =>
    `<option value="${escapeHtml(p)}" ${p === e.pessoa ? 'selected' : ''}>${escapeHtml(p)}</option>`
  ).join('');

  const methodSel = document.getElementById('edit-method');
  ['Débito','Crédito','Pix','Dinheiro','Vale'].forEach(m => {
    const opt = methodSel.querySelector(`option[value="${m}"]`);
    if (opt) opt.selected = (m === e.metodo);
  });

  document.getElementById('edit-cat').innerHTML = getAllCategories().map(c =>
    `<option value="${escapeHtml(c.id)}" ${c.nome === e.categoria ? 'selected' : ''}>${c.icone} ${escapeHtml(c.nome)}</option>`
  ).join('');

  populateEditCardSelect(e.metodo, e.cardId || null);
  _updateEditPagoPor(e.pagoPor || '');
  document.getElementById('edit-modal').classList.add('open');
}

// Mostra o seletor "quem adiantou" só para gastos manuais do Casal (não-fatura).
// Lê o estado atual do modal (pessoa/método/cartão) para decidir a visibilidade.
function _updateEditPagoPor(preselect) {
  const wrap = document.getElementById('edit-pagopor-wrap');
  const sel  = document.getElementById('edit-pagopor');
  if (!wrap || !sel) return;
  const pessoa = document.getElementById('edit-person')?.value;
  const metodo = document.getElementById('edit-method')?.value;
  const cardId = document.getElementById('edit-card')?.value || null;
  const isManualCouple = pessoa === appConfig.coupleName &&
    !(metodo === 'Crédito' && cardId && _coupleCardIds().has(cardId));
  if (!isManualCouple) { wrap.style.display = 'none'; return; }
  const cur = preselect !== undefined ? preselect : sel.value;
  sel.innerHTML =
    `<option value="">Dividido 50/50 (sem dívida)</option>` +
    [appConfig.p1Name, appConfig.p2Name].map(p =>
      `<option value="${escapeHtml(p)}" ${p === cur ? 'selected' : ''}>${escapeHtml(p)} pagou sozinho(a)</option>`
    ).join('');
  wrap.style.display = 'block';
}

function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function openAddModal() {
  renderPersonPills();
  onAddMethodChange();
  document.getElementById('add-modal').classList.add('open');
  setTimeout(() => document.getElementById('add-msg').focus(), 50);
}

function closeAddModal() {
  document.getElementById('add-modal').classList.remove('open');
}

function saveEdit() {
  const id  = parseFloat(document.getElementById('edit-id').value);
  const exp = expenses.find(x => x.id === id);
  if (!exp) return;

  // Capture originals BEFORE mutation so we can learn from fatura corrections
  const isFatura        = exp.origem === 'fatura';
  const origMerchantKey = isFatura ? (exp.descricaoOriginal || exp.descricao) : null;
  const origDesc        = exp.descricao;
  const origCatId       = exp.categoriaId;
  const origValor       = exp.valor;
  const _antesEdit      = _expLogSnapshot(exp); // para o log de auditoria (antes/depois)

  const catId  = document.getElementById('edit-cat').value;
  const catObj = getAllCategories().find(c => c.id === catId);
  exp.descricao = document.getElementById('edit-desc').value.trim();
  exp.valor     = parseCurrencyInput(document.getElementById('edit-valor').value);
  const iso     = document.getElementById('edit-data').value;
  exp.data      = iso ? new Date(iso+'T12:00:00').toLocaleDateString('pt-BR') : exp.data;
  exp.pessoa    = document.getElementById('edit-person').value;
  exp.metodo    = document.getElementById('edit-method').value;
  if (catObj) { exp.categoria=catObj.nome; exp.categoriaId=catObj.id; exp.icone=catObj.icone; exp.cor=catObj.cor; }
  exp.cardId = document.getElementById('edit-card')?.value || null;
  // Recalcula competência se data ou método mudaram
  exp.mesCompetencia = calcularMesCompetencia(exp.data, exp.metodo, exp.cardId);

  // Pagador individual (só faz sentido em gasto manual do Casal — ver _isManualCoupleExpense).
  // Fora desse caso, limpa o campo para não poluir gastos pessoais/fatura.
  if (_isManualCoupleExpense(exp)) exp.pagoPor = document.getElementById('edit-pagopor')?.value || '';
  else                             delete exp.pagoPor;

  // Confirm variable estimate when user explicitly changes the valor
  if (exp.isEstimate === true && Math.abs(exp.valor - origValor) > 0.001) {
    exp.isEstimate = false;
  }

  // Learn from correction: if user changed desc or category on a fatura entry
  if (isFatura && origMerchantKey && catObj) {
    if (origDesc !== exp.descricao || origCatId !== exp.categoriaId) {
      _merchantLearn(origMerchantKey, exp.descricao, exp.categoriaId, exp.categoria);
    }
  }

  auditLog({ tipo: 'acao_usuario', categoria: 'lancamento', acao: 'editar', ator: exp.pessoa || 'Usuário', detalhes: { id: exp.id }, antes: _antesEdit, depois: _expLogSnapshot(exp) });
  saveAll(); updateMetrics(); renderFaturas(); renderRecent(); renderList(); renderCharts(); renderBudgetAlerts();
  closeModal('edit-modal');
  notify('Lançamento atualizado!', 'ok');
}

// ─── COMPETÊNCIA DE CARTÃO ────────────────────────────────────────
/*
 * Competência: em qual mês o gasto "pesa" no orçamento?
 *
 * Débito / Pix / Dinheiro → mês da compra (dinheiro já saiu da conta)
 *
 * Crédito → mês do vencimento da fatura:
 *   1. Se compra_dia <= diaFechamento → compra entra na fatura deste mês
 *   2. Se compra_dia >  diaFechamento → compra vai para a fatura do mês seguinte
 *   3. A fatura vence no diaVencimento:
 *      - Se diaVencimento <= diaFechamento → vencimento cai no mês após o fechamento
 *      - Se diaVencimento >  diaFechamento → vencimento cai no mesmo mês do fechamento
 *
 * Exemplo C6 Bank (fechamento=30, vencimento=10):
 *   Compra 15/06 → fecha 30/06 → vence 10/07 → competência = 2026-07
 *   Compra 02/07 → fecha 30/07 → vence 10/08 → competência = 2026-08
 *
 * Se diaFechamento ou diaVencimento não estiverem configurados (= 0),
 * retorna o próprio mês da compra (comportamento neutro / sem mudança).
 */
function calcularMesCompetencia(dataCompra, metodo, cardId) {
  let closeDay, dueDay;
  if (cardId) {
    const card = cards.find(c => c.id === cardId);
    closeDay = card?.diaFechamento || 0;
    dueDay   = card?.diaVencimento || 0;
  }
  if (!closeDay || !dueDay) {
    closeDay = appConfig.diaFechamento || 0;
    dueDay   = appConfig.diaVencimento || 0;
  }

  // Método não-crédito ou configuração ausente → mês da própria compra
  if (metodo !== 'Crédito' || !closeDay || !dueDay) {
    const iso = dataCompra.includes('/') ? parseDateStr(dataCompra) : dataCompra;
    return iso.slice(0, 7);
  }

  const [dd, mm, yyyy] = dataCompra.split('/').map(Number);

  // Em qual fatura entra esta compra?
  let billMonth = mm, billYear = yyyy;
  if (dd > closeDay) {
    // Após o fechamento → próxima fatura
    billMonth++;
    if (billMonth > 12) { billMonth = 1; billYear++; }
  }

  // Quando essa fatura vence?
  let dueMonth = billMonth, dueYear = billYear;
  if (dueDay <= closeDay) {
    // Vencimento antes/igual ao fechamento → cai no mês seguinte ao do fechamento
    dueMonth++;
    if (dueMonth > 12) { dueMonth = 1; dueYear++; }
  }

  return `${dueYear}-${String(dueMonth).padStart(2, '0')}`;
}

// Recalcula mesCompetencia para todos os lançamentos de crédito existentes.
// Chamada ao salvar a configuração de cartão ou manualmente pelo botão na Config.
function recalcularCompetencias(filterCardId) {
  let count = 0;
  expenses.forEach(e => {
    if (e.metodo === 'Crédito' && e.data) {
      if (filterCardId !== undefined && e.cardId !== filterCardId) return;
      const mc = calcularMesCompetencia(e.data, 'Crédito', e.cardId || null);
      if (e.mesCompetencia !== mc) { e.mesCompetencia = mc; count++; }
    }
  });
  if (count) { saveAll(); updateMetrics(); renderRecent(); renderList(); renderBudgetAlerts(); }
  notify(count ? `Competência recalculada para ${count} lançamento(s).` : 'Nenhuma alteração necessária.', count ? 'ok' : 'info');
}

// ─── METRICS ──────────────────────────────────────────────────────
function contextMonthExpenses() {
  return expenses.filter(e => {
    if (!e.data) return false;
    // Crédito com mesCompetencia → filtra pelo mês em que a fatura vence (quando o dinheiro sai)
    // Outros métodos → filtra pelo mês da data da compra (dinheiro já saiu no ato)
    const monthKey = (e.metodo === 'Crédito' && e.mesCompetencia)
      ? e.mesCompetencia
      : (e.data.includes('/') ? parseDateStr(e.data) : e.data).slice(0, 7);
    return monthKey === currentMonth && (!e.contexto || e.contexto === currentContext);
  });
}

function updateMetrics() {
  const me    = contextMonthExpenses();
  const total = me.reduce((a, e) => a + e.valor, 0);
  document.getElementById('m-total').textContent = fmt(total);
  document.getElementById('m-count').textContent = me.length + ' lançamento' + (me.length !== 1 ? 's' : '');
  // 5th metric: goal progress — always sync regardless of expense count
  const goal      = getMonthGoal(currentMonth);
  const metaEl    = document.getElementById('m-meta');
  const metricsEl = document.getElementById('metrics');
  if (goal && metaEl) {
    const pct  = Math.min(100, (total / goal.teto) * 100);
    const over = total > goal.teto;
    document.getElementById('m-meta-pct').textContent = pct.toFixed(0) + '%';
    document.getElementById('m-meta-pct').style.color = over ? 'var(--danger)' : 'var(--success)';
    document.getElementById('m-meta-sub').textContent = 'de ' + fmt(goal.teto);
    metaEl.style.display = '';
    if (metricsEl) metricsEl.style.gridTemplateColumns = 'repeat(5,1fr)';
  } else if (metaEl) {
    metaEl.style.display = 'none';
    if (metricsEl) metricsEl.style.gridTemplateColumns = 'repeat(4,1fr)';
  }
  if (!me.length) {
    ['m-maior','m-maior-desc','m-cat','m-cat-val','m-media'].forEach(i => document.getElementById(i).textContent = '—');
    renderVariableEstimateAlerts();
    return;
  }
  const maior = me.reduce((a, b) => b.valor > a.valor ? b : a);
  document.getElementById('m-maior').textContent      = fmt(maior.valor);
  document.getElementById('m-maior-desc').textContent = maior.descricao;
  const catMap = {};
  me.forEach(e => catMap[e.categoria] = (catMap[e.categoria] || 0) + e.valor);
  const top = Object.entries(catMap).sort((a, b) => b[1]-a[1])[0];
  document.getElementById('m-cat').textContent     = top[0];
  document.getElementById('m-cat-val').textContent = fmt(top[1]);
  document.getElementById('m-media').textContent   = fmt(total / me.length);
  renderVariableEstimateAlerts();
}

// ─── RENDER EXPENSE ITEM ──────────────────────────────────────────
function expenseItemHTML(e) {
  const pc      = personColor(e.pessoa);
  const mi      = METHOD_ICONS[e.metodo] || '';
  const cardObj = e.cardId ? cards.find(c => c.id === e.cardId) : null;
  const installBadge = e.installment
    ? `<span class="badge-installment">${e.installment.current}/${e.installment.total}x ${fmt(e.installment.parcela)}</span>` : '';
  const splitBadge = e.splitOf
    ? `<span class="badge" style="background:#fef3c7;color:#92400e">${e.splitPct}% de ${fmt(e.splitOf)}</span>` : '';
  // fixedBadge only for entries without isEstimate tracking (regular fixas, old entries)
  const fixedBadge    = e.fixedId && e.isEstimate == null ? `<span class="badge" style="background:#ede9fe;color:#6d28d9">🔁 fixa</span>` : '';
  const estimateBadge = e.isEstimate === true
    ? `<span class="badge" style="background:#fff7ed;color:#c2410c">📊 Estimativa${e.valorEstimado?' méd.'+fmt(e.valorEstimado):''}</span>` : '';
  const confirmedBadge= e.isEstimate === false
    ? `<span class="badge" style="background:#dcfce7;color:#16a34a">✅ Valor real</span>` : '';
  const faturaBadge = e.origem === 'fatura' ? `<span class="badge" style="background:#dbeafe;color:#1e40af">📄 fatura</span>` : '';
  const pagoPorBadge = (e.pagoPor && _isManualCoupleExpense(e))
    ? `<span class="badge" style="background:#e0e7ff;color:#4338ca" title="Adiantado por ${escapeHtml(e.pagoPor)} — entra na divisão">💸 ${escapeHtml(e.pagoPor)} adiantou</span>` : '';
  const ctxBadge    = e.contexto === 'empresa' ? `<span class="badge" style="background:#e0f2fe;color:#0369a1">🏢</span>` : '';
  // Badge de competência: mostra quando a fatura ainda não venceu (dinheiro ainda não saiu da conta)
  const hoje = new Date().toISOString().slice(0, 7);
  const cartaoBadge = (e.metodo === 'Crédito' && e.mesCompetencia && e.mesCompetencia !== (e.data.includes('/') ? parseDateStr(e.data) : e.data).slice(0,7))
    ? (e.mesCompetencia > hoje
        ? `<span class="badge" style="background:#fef3c7;color:#92400e" title="Vence em ${formatMonth(e.mesCompetencia)}">💳 a pagar ${formatMonth(e.mesCompetencia)}</span>`
        : e.mesCompetencia === hoje
          ? `<span class="badge" style="background:#fef9c3;color:#a16207" title="Fatura vence este mês">💳 este mês</span>`
          : `<span class="badge" style="background:#dcfce7;color:#166534" title="Fatura já paga">✓ pago</span>`)
    : '';
  return `<div class="expense-item">
    <div class="expense-icon" style="background:${escapeHtml(e.cor||'#eee')}22">${e.icone||'📦'}</div>
    <div class="expense-main">
      <div class="expense-desc">${escapeHtml(e.descricao)}</div>
      <div class="expense-meta">
        <span class="badge" style="background:${escapeHtml(e.cor||'#eee')}22;color:${escapeHtml(e.cor||'#888')}">${escapeHtml(e.categoria)}</span>
        <span class="badge-person" style="background:${pc}22;color:${pc}">${escapeHtml(e.pessoa)}</span>
        ${mi ? `<span>${mi} ${escapeHtml(cardObj ? cardObj.nome + (cardObj.final ? ' •' + cardObj.final : '') : e.metodo)}</span>` : ''}
        <span>${escapeHtml(e.data)}</span>
        ${installBadge}${splitBadge}${fixedBadge}${estimateBadge}${confirmedBadge}${faturaBadge}${pagoPorBadge}${cartaoBadge}${ctxBadge}
        ${e.confianca < 20 ? '<span style="color:#f59e0b;font-size:9px">⚠️ verifique cat.</span>' : ''}
      </div>
    </div>
    <div class="expense-amount">${fmt(e.valor)}</div>
    <div class="expense-actions">
      <button class="btn-icon" onclick="openEdit(${e.id})" title="Editar">✏️</button>
      <button class="btn-icon" onclick="deleteExpense(${e.id})" title="Remover">🗑</button>
    </div>
  </div>`;
}

function renderRecent() {
  const el    = document.getElementById('recent-list');
  const items = contextMonthExpenses().slice(0, 5);
  el.innerHTML = items.length ? items.map(expenseItemHTML).join('') : '<div class="empty"><div class="empty-icon">🧾</div>Nenhum gasto ainda.</div>';
}

function renderList() {
  _renderAdvancedFilterPills();
  _renderSortButtons();

  const search   = (document.getElementById('search-input')?.value || '').toLowerCase();
  const allItems = contextMonthExpenses();
  let items = allItems;

  // Category pill filter
  if (activeFilter) items = items.filter(e => e.categoriaId === activeFilter || e.categoria === activeFilter);

  // Full-text search
  if (search) items = items.filter(e =>
    (e.descricao||'').toLowerCase().includes(search) ||
    (e.mensagem||'').toLowerCase().includes(search)
  );

  // Advanced filters (all AND)
  const { pessoa, dateFrom, dateTo, valorMin, valorMax, metodo, cardId, origem } = _listFilters;
  if (pessoa)  items = items.filter(e => e.pessoa === pessoa);
  if (dateFrom) items = items.filter(e => parseDateStr(e.data) >= dateFrom);
  if (dateTo)   items = items.filter(e => parseDateStr(e.data) <= dateTo);
  if (valorMin !== null) items = items.filter(e => e.valor >= valorMin);
  if (valorMax !== null) items = items.filter(e => e.valor <= valorMax);
  if (metodo)   items = items.filter(e => e.metodo === metodo);
  if (cardId)   items = items.filter(e => e.cardId === cardId);
  if (origem) {
    if      (origem === 'manual') items = items.filter(e => !e.origem && !e.fixedId && e.metodo !== 'Telegram');
    else if (origem === 'bot')    items = items.filter(e => e.metodo === 'Telegram');
    else if (origem === 'fatura') items = items.filter(e => e.origem === 'fatura');
    else if (origem === 'fixa')   items = items.filter(e => !!e.fixedId);
  }

  // Sort
  items = [...items].sort((a, b) => {
    let cmp = 0;
    if (_listSort.field === 'data')      cmp = parseDateStr(a.data).localeCompare(parseDateStr(b.data));
    if (_listSort.field === 'valor')     cmp = a.valor - b.valor;
    if (_listSort.field === 'categoria') cmp = (a.categoria||'').localeCompare(b.categoria||'');
    return _listSort.dir === 'desc' ? -cmp : cmp;
  });

  // Count display
  const n = items.length, t = allItems.length;
  document.getElementById('list-count').textContent =
    n === t ? `${t} iten${t !== 1 ? 's' : ''}` : `${n} de ${t} iten${t !== 1 ? 's' : ''}`;

  _renderFilterSummary(items, allItems, search);

  const el = document.getElementById('all-list');
  el.innerHTML = items.length
    ? items.map(expenseItemHTML).join('')
    : '<div class="empty"><div class="empty-icon">🔍</div>Nenhum resultado para os filtros aplicados.</div>';
}

function renderCatFilters() {
  const cats = [...new Map(contextMonthExpenses().map(e => [e.categoria, { id: e.categoriaId||e.categoria, label: e.categoria }])).values()];
  document.getElementById('cat-filters').innerHTML = cats.map(c =>
    `<button class="filter-pill ${activeFilter===c.id?'active':''}" onclick="setFilter('${escapeHtml(c.id)}')">${escapeHtml(c.label)}</button>`
  ).join('');
}

function setFilter(id) { activeFilter = activeFilter===id?null:id; renderList(); renderCatFilters(); }
function clearFilters() { clearAllListFilters(); } // legacy alias

function clearAllListFilters() {
  _listFilters = { pessoa: null, dateFrom: '', dateTo: '', valorMin: null, valorMax: null, metodo: null, cardId: null, origem: null };
  activeFilter = null;
  const si = document.getElementById('search-input');
  if (si) si.value = '';
  ['filter-date-from','filter-date-to','filter-valor-min','filter-valor-max'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const cs = document.getElementById('filter-card-sel');
  if (cs) cs.value = '';
  renderList(); renderCatFilters();
}

function toggleAdvancedFilters() {
  _advFiltersOpen = !_advFiltersOpen;
  const af  = document.getElementById('advanced-filters');
  const tog = document.getElementById('adv-filter-toggle');
  if (af)  af.style.display  = _advFiltersOpen ? '' : 'none';
  if (tog) tog.textContent   = _advFiltersOpen ? '⚙ Filtros ▴' : '⚙ Filtros ▾';
  if (_advFiltersOpen) { populateListCardSelect(); _renderAdvancedFilterPills(); }
}

function _setListFilter(key, value) {
  _listFilters[key] = value;
  renderList();
}

function _handleFilterPillClick(btn) {
  const key = btn.dataset.filterKey;
  const val = btn.dataset.filterVal || null;
  _listFilters[key] = _listFilters[key] === val ? null : val;
  _renderAdvancedFilterPills();
  renderList();
}

function _setListSort(field) {
  if (_listSort.field === field) {
    _listSort.dir = _listSort.dir === 'desc' ? 'asc' : 'desc';
  } else {
    _listSort.field = field;
    _listSort.dir   = field === 'categoria' ? 'asc' : 'desc';
  }
  renderList();
}

function _renderSortButtons() {
  const icons   = { data: '📅', valor: '💰', categoria: '🏷' };
  const labels  = { data: 'Data', valor: 'Valor', categoria: 'Categoria' };
  const dirIcon = _listSort.dir === 'desc' ? ' ↓' : ' ↑';
  ['data','valor','categoria'].forEach(f => {
    const btn = document.getElementById('sort-' + f);
    if (!btn) return;
    const active = _listSort.field === f;
    btn.className = 'filter-pill' + (active ? ' active' : '');
    btn.textContent = icons[f] + ' ' + labels[f] + (active ? dirIcon : '');
  });
}

function populateListCardSelect() {
  const sel = document.getElementById('filter-card-sel');
  if (!sel) return;
  sel.innerHTML = `<option value="">Todos os cartões</option>` +
    cards.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.nome)}${c.final?' •'+escapeHtml(c.final):''} (${escapeHtml(c.dono)})</option>`).join('');
  sel.value = _listFilters.cardId || '';
}

function _renderAdvancedFilterPills() {
  // Pessoa
  const pessoaEl = document.getElementById('filter-pessoa-pills');
  if (pessoaEl) {
    const opts = [{ val: null, label: 'Todos' }, ...getPersons().map(p => ({ val: p, label: p }))];
    pessoaEl.innerHTML = opts.map(o => {
      const v = o.val === null ? '' : escapeHtml(o.val);
      return `<button class="filter-pill${_listFilters.pessoa===o.val?' active':''}" data-filter-key="pessoa" data-filter-val="${v}" onclick="_handleFilterPillClick(this)">${escapeHtml(o.label)}</button>`;
    }).join('');
  }
  // Method
  const methodEl = document.getElementById('filter-method-pills');
  if (methodEl) {
    const opts = [
      { val: null,        label: 'Todos' },
      { val: 'Crédito',   label: '💳 Crédito' },
      { val: 'Débito',    label: '💳 Débito' },
      { val: 'Pix',       label: '⚡ Pix' },
      { val: 'Dinheiro',  label: '💵 Dinheiro' },
      { val: 'Telegram',  label: '🤖 Telegram' },
    ];
    methodEl.innerHTML = opts.map(o => {
      const v = o.val === null ? '' : escapeHtml(o.val);
      return `<button class="filter-pill${_listFilters.metodo===o.val?' active':''}" data-filter-key="metodo" data-filter-val="${v}" onclick="_handleFilterPillClick(this)">${escapeHtml(o.label)}</button>`;
    }).join('');
  }
  // Origin
  const origemEl = document.getElementById('filter-origem-pills');
  if (origemEl) {
    const opts = [
      { val: null,     label: 'Todos' },
      { val: 'manual', label: '✏️ Manual' },
      { val: 'bot',    label: '🤖 Bot' },
      { val: 'fatura', label: '📄 Fatura' },
      { val: 'fixa',   label: '🔁 Fixa' },
    ];
    origemEl.innerHTML = opts.map(o => {
      const v = o.val === null ? '' : escapeHtml(o.val);
      return `<button class="filter-pill${_listFilters.origem===o.val?' active':''}" data-filter-key="origem" data-filter-val="${v}" onclick="_handleFilterPillClick(this)">${escapeHtml(o.label)}</button>`;
    }).join('');
  }
}

function _renderFilterSummary(items, allItems, search) {
  const el = document.getElementById('filter-summary');
  if (!el) return;

  const parts = [];
  if (_listFilters.pessoa)  parts.push(escapeHtml(_listFilters.pessoa));
  if (_listFilters.metodo)  parts.push(escapeHtml(_listFilters.metodo));
  if (_listFilters.cardId) {
    const c = cards.find(x => x.id === _listFilters.cardId);
    if (c) parts.push(escapeHtml(c.nome + (c.final ? ' •'+c.final : '')));
  }
  if (_listFilters.origem) {
    parts.push({ manual:'Manual', bot:'Bot', fatura:'Fatura', fixa:'Fixa' }[_listFilters.origem] || _listFilters.origem);
  }
  if (_listFilters.dateFrom || _listFilters.dateTo) {
    const f = _listFilters.dateFrom ? new Date(_listFilters.dateFrom+'T12:00:00').toLocaleDateString('pt-BR',{month:'short',year:'numeric'}) : '';
    const t = _listFilters.dateTo   ? new Date(_listFilters.dateTo  +'T12:00:00').toLocaleDateString('pt-BR',{month:'short',year:'numeric'}) : '';
    parts.push(f && t ? `${f} → ${t}` : f || t);
  }
  if (_listFilters.valorMin !== null || _listFilters.valorMax !== null) {
    const lo = _listFilters.valorMin !== null ? `R$ ${Number(_listFilters.valorMin).toLocaleString('pt-BR',{minimumFractionDigits:0})}` : '';
    const hi = _listFilters.valorMax !== null ? `R$ ${Number(_listFilters.valorMax).toLocaleString('pt-BR',{minimumFractionDigits:0})}` : '';
    parts.push(lo && hi ? `${lo}–${hi}` : lo ? `≥ ${lo}` : `≤ ${hi}`);
  }
  if (activeFilter) {
    const cat = getAllCategories().find(c => c.id === activeFilter || c.nome === activeFilter);
    if (cat) parts.push(escapeHtml(cat.nome));
  }
  if (search) parts.push(`"${escapeHtml(search)}"`);

  if (!parts.length) { el.style.display = 'none'; return; }

  const totalVal = items.reduce((s, e) => s + e.valor, 0);
  el.innerHTML = `<span style="color:var(--accent)">Filtrando: ${parts.join(' · ')}</span> — <strong>${items.length} de ${allItems.length} iten${allItems.length!==1?'s':'s'} · ${fmt(totalVal)}</strong>`;
  el.style.display = '';
}

// ─── CHARTS ───────────────────────────────────────────────────────
function renderCharts() {
  const me = contextMonthExpenses();
  const allCats   = getAllCategories();
  const catById   = Object.fromEntries(allCats.map(c => [c.id,           c]));
  const catByName = Object.fromEntries(allCats.map(c => [c.nome.toLowerCase(), c]));
  const catMap = {};
  me.forEach(e => {
    if (!catMap[e.categoria]) {
      const def   = catById[e.categoriaId] || catByName[(e.categoria||'').toLowerCase()];
      const cor   = def?.cor   || e.cor   || '#888';
      const icone = def?.icone || e.icone || '📦';
      catMap[e.categoria] = { total:0, cor, icone };
    }
    catMap[e.categoria].total += e.valor;
  });
  const cats = Object.keys(catMap).sort((a,b) => catMap[b].total-catMap[a].total);
  document.getElementById('chart-legend').innerHTML = cats.map(c =>
    `<span class="legend-item"><span class="legend-dot" style="background:${escapeHtml(catMap[c].cor)}"></span>${catMap[c].icone} ${escapeHtml(c)} · ${fmt(catMap[c].total)}</span>`
  ).join('');
  if (chartCat) chartCat.destroy();
  chartCat = new Chart(document.getElementById('chart-cat'), {
    type: 'doughnut',
    data: { labels: cats, datasets: [{ data: cats.map(c=>catMap[c].total), backgroundColor: cats.map(c=>catMap[c].cor), borderWidth:0 }] },
    options: { responsive:true, maintainAspectRatio:false, cutout:'58%', plugins:{ legend:{display:false}, tooltip:{callbacks:{label:ctx=>' '+fmt(ctx.raw)}} } }
  });

  const pColors = getPersonColors();
  const people  = [...new Set(me.map(e=>e.pessoa))].sort();
  const pVals   = people.map(p => me.filter(e=>e.pessoa===p).reduce((a,e)=>a+e.valor,0));
  const pBgs    = people.map(p => pColors[p] || '#aaa');
  if (chartPerson) chartPerson.destroy();
  chartPerson = new Chart(document.getElementById('chart-person'), {
    type:'bar',
    data:{ labels:people, datasets:[{ data:pVals, backgroundColor:pBgs, borderRadius:6, borderWidth:0 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}, tooltip:{callbacks:{label:ctx=>' '+fmt(ctx.raw)}}},
      scales:{ y:{ticks:{callback:v=>'R$'+v.toLocaleString('pt-BR'),color:getComputedStyle(document.documentElement).getPropertyValue('--muted').trim()},grid:{color:getComputedStyle(document.documentElement).getPropertyValue('--border').trim()}}, x:{grid:{display:false},ticks:{color:getComputedStyle(document.documentElement).getPropertyValue('--muted').trim()}} } }
  });
}

// ─── EVOLUTION CHART ─────────────────────────────────────────────

function getExpensesForMonth(month) {
  return expenses.filter(e => {
    if (!e.data) return false;
    const monthKey = (e.metodo === 'Crédito' && e.mesCompetencia)
      ? e.mesCompetencia
      : (e.data.includes('/') ? parseDateStr(e.data) : e.data).slice(0, 7);
    return monthKey === month && (!e.contexto || e.contexto === currentContext);
  });
}

function _getLastNMonths(n) {
  const [yr, mo] = currentMonth.split('-').map(Number);
  const months = [];
  for (let i = n - 1; i >= 0; i--) {
    let m = mo - i, y = yr;
    while (m <= 0) { m += 12; y--; }
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return months;
}

function renderEvolutionChart() {
  const canvas = document.getElementById('chart-evolution');
  if (!canvas) return;

  const months  = _getLastNMonths(6);
  const moNames = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const labels  = months.map(m => moNames[parseInt(m.split('-')[1]) - 1]);

  const mode = document.getElementById('evolution-mode')?.value || 'total';
  const cs   = getComputedStyle(document.documentElement);
  const textColor   = cs.getPropertyValue('--muted').trim();
  const borderColor = cs.getPropertyValue('--border').trim();
  const accentColor = cs.getPropertyValue('--accent').trim();

  const allCats   = getAllCategories();
  const catById   = Object.fromEntries(allCats.map(c => [c.id,           c]));
  const catByName = Object.fromEntries(allCats.map(c => [c.nome.toLowerCase(), c]));

  let datasets = [];

  if (mode === 'total') {
    const totals = months.map(m => getExpensesForMonth(m).reduce((a, e) => a + e.valor, 0));
    datasets.push({
      label: 'Total gasto',
      data: totals,
      borderColor: accentColor,
      backgroundColor: accentColor + '22',
      fill: true,
      tension: 0.35,
      pointRadius: 4,
      pointHoverRadius: 6,
      borderWidth: 2.5,
    });
    // Teto da meta: dashed line — only shown if at least one month has a goal
    const goalData = months.map(m => getMonthGoal(m)?.teto ?? null);
    if (goalData.some(v => v !== null)) {
      const warnColor = cs.getPropertyValue('--warn').trim();
      datasets.push({
        label: 'Teto da meta',
        data: goalData,
        borderColor: warnColor,
        backgroundColor: 'transparent',
        borderDash: [6, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        tension: 0,
        spanGaps: true,
      });
    }
  } else {
    // Per-category: top 5 by total across the window
    const catTotalMap = {}, catColorMap = {};
    months.forEach(m => {
      getExpensesForMonth(m).forEach(e => {
        const k = e.categoria;
        catTotalMap[k] = (catTotalMap[k] || 0) + e.valor;
        if (!catColorMap[k]) {
          const def = catById[e.categoriaId] || catByName[(e.categoria || '').toLowerCase()];
          catColorMap[k] = def?.cor || e.cor || '#888';
        }
      });
    });
    const top5 = Object.keys(catTotalMap).sort((a, b) => catTotalMap[b] - catTotalMap[a]).slice(0, 5);
    top5.forEach(cat => {
      const monthTotals = months.map(m =>
        getExpensesForMonth(m).filter(e => e.categoria === cat).reduce((a, e) => a + e.valor, 0)
      );
      datasets.push({
        label: cat,
        data: monthTotals,
        borderColor: catColorMap[cat] || '#888',
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.35,
        pointRadius: 3,
        pointHoverRadius: 5,
        borderWidth: 2,
      });
    });
  }

  if (chartEvolution) chartEvolution.destroy();
  chartEvolution = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: mode === 'categoria',
          labels: { color: textColor, font: { size: 11 }, boxWidth: 14, boxHeight: 2, padding: 12 },
        },
        tooltip: {
          callbacks: {
            label: ctx => ctx.raw === null ? null : ' ' + ctx.dataset.label + ': ' + fmt(ctx.raw),
          },
        },
      },
      scales: {
        x: {
          ticks: { color: textColor, font: { size: 11 } },
          grid:  { color: borderColor },
        },
        y: {
          beginAtZero: true,
          ticks: { callback: v => 'R$' + Number(v).toLocaleString('pt-BR'), color: textColor, font: { size: 11 } },
          grid:  { color: borderColor },
        },
      },
    },
  });

  renderEvolutionSummary(months);
}

function renderEvolutionSummary(months) {
  const el = document.getElementById('evolution-summary');
  if (!el || months.length < 2) return;

  const thisMo = months[months.length - 1];
  const prevMo = months[months.length - 2];

  const thisExps  = getExpensesForMonth(thisMo);
  const prevExps  = getExpensesForMonth(prevMo);
  const thisTotal = thisExps.reduce((a, e) => a + e.valor, 0);
  const prevTotal = prevExps.reduce((a, e) => a + e.valor, 0);

  // Total trend: compact "+X% / vs anterior"
  let trendChip = '';
  if (prevTotal > 0 && thisTotal > 0) {
    const pct   = ((thisTotal - prevTotal) / prevTotal) * 100;
    const sign  = pct >= 0 ? '+' : '';
    const color = pct > 0 ? 'var(--danger)' : 'var(--success)';
    trendChip = `<strong style="color:${color}">${sign}${pct.toFixed(0)}%</strong>`;
  } else if (thisTotal === 0 && prevTotal > 0) {
    trendChip = `<strong style="color:var(--success)">−100%</strong>`;
  }

  // Category-level changes: only consider cats with meaningful prev spending (>10)
  const catThis = {}, catPrev = {};
  thisExps.forEach(e => catThis[e.categoria] = (catThis[e.categoria] || 0) + e.valor);
  prevExps.forEach(e => catPrev[e.categoria] = (catPrev[e.categoria] || 0) + e.valor);
  const allCatNames = [...new Set([...Object.keys(catThis), ...Object.keys(catPrev)])];

  let topGrowth = { cat: null, pct: -Infinity };
  let topDrop   = { cat: null, pct:  Infinity };
  allCatNames.forEach(cat => {
    const t = catThis[cat] || 0;
    const p = catPrev[cat] || 0;
    if (p > 10 && t > 0) {
      const pct = (t - p) / p * 100;
      if (pct > topGrowth.pct) topGrowth = { cat, pct };
      if (pct < topDrop.pct)   topDrop   = { cat, pct };
    }
  });

  const parts = [];
  if (trendChip) {
    parts.push(`Mês atual vs anterior: ${trendChip} (${fmt(thisTotal)})`);
  } else if (thisTotal > 0) {
    parts.push(`Mês atual: ${fmt(thisTotal)}`);
  }
  if (topGrowth.cat && topGrowth.pct > 0) {
    parts.push(`📈 Maior alta: <strong>${escapeHtml(topGrowth.cat)}</strong> (+${topGrowth.pct.toFixed(0)}%)`);
  }
  if (topDrop.cat && topDrop.pct < 0 && topDrop.cat !== topGrowth.cat) {
    parts.push(`📉 Maior queda: <strong>${escapeHtml(topDrop.cat)}</strong> (${topDrop.pct.toFixed(0)}%)`);
  }

  el.innerHTML = parts.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:4px 16px">${parts.map(p => `<span>${p}</span>`).join('')}</div>`
    : '';
}

// ─── BACKUP ───────────────────────────────────────────────────────

// Campos de credencial que NUNCA devem sair no backup (texto puro ou cifrado).
const SECRET_CONFIG_KEYS = ['tgToken', 'tgTokenEnc', 'sheetsSecret', 'sheetsSecretEnc', 'appsScriptUrl'];

// Monta o objeto de backup já sanitizado. Função pura (sem I/O) para ser testável.
function buildBackupPayload() {
  // Nunca incluir credenciais no backup — se o arquivo for compartilhado/subido
  // para nuvem, o token do bot e o secret do Sheets vazariam em texto puro.
  // Também não exportamos as versões criptografadas (tgTokenEnc/sheetsSecretEnc),
  // pois a chave do safeStorage é atrelada ao dispositivo/usuário de origem.
  const safeConfig = { ...appConfig };
  SECRET_CONFIG_KEYS.forEach(k => delete safeConfig[k]);
  return {
    _version:   1,
    appVersion: '2.0',
    backupDate: new Date().toISOString(),
    expenses, customCats, budgets, fixedExpenses, cards, monthGoals,
    merchantMap, acertos, faturaPagamentos,
    deletedIds: [...deletedExpenseIds],
    config: safeConfig,
  };
}

// SHA-256 hex via Web Crypto (usado no modo web; no Electron o hash vem do main).
async function _sha256Subtle(str) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return ''; }
}

// Monta o arquivo de backup (formato 2): wrapper com checksum de integridade e,
// se `password` for informada, conteúdo criptografado (AES-256-GCM via IPC).
// Retorna a string JSON pronta para gravar, ou null se falhar/cancelar.
async function _buildBackupFile(password) {
  const payload    = buildBackupPayload();
  const payloadStr = JSON.stringify(payload);
  const wrapper = {
    _finannza:  'backup',
    _format:    2,
    appVersion: payload.appVersion,
    backupDate: payload.backupDate,
    encrypted:  false,
    checksum:   '',
  };
  if (isElectron()) {
    const sealed = await window.electronAPI.backupSeal(payloadStr, password || '');
    if (!sealed || !sealed.ok) { notify('Falha ao preparar o backup.', 'err'); return null; }
    wrapper.checksum = sealed.checksum;
    if (sealed.encrypted) {
      Object.assign(wrapper, {
        encrypted: true, cipher: sealed.cipher, kdf: sealed.kdf,
        salt: sealed.salt, iv: sealed.iv, authTag: sealed.authTag, data: sealed.data,
      });
    } else {
      wrapper.payload = payload;
    }
  } else {
    if (password) { notify('Backup com senha disponível apenas no app instalado.', 'warn'); return null; }
    wrapper.checksum = await _sha256Subtle(payloadStr);
    wrapper.payload  = payload;
  }
  return JSON.stringify(wrapper, null, 2);
}

// Exporta sem senha (botão padrão).
function exportBackup() { return _exportBackupWith(''); }
// Abre o modal para exportar com senha.
function exportBackupEncrypted() { _openBackupPassModal('export'); }

async function _exportBackupWith(password) {
  const content = await _buildBackupFile(password);
  if (content == null) return;
  const now      = new Date();
  const filename = `finannza-backup-${now.toISOString().slice(0, 10)}${password ? '-protegido' : ''}.json`;

  if (isElectron()) {
    const savePath = await window.electronAPI.saveFileDialog({
      title: 'Salvar backup', defaultPath: filename,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!savePath) return;
    const ok = await window.electronAPI.writeFile(savePath, content);
    if (!ok) { notify('Erro ao salvar o arquivo de backup.', 'err'); return; }
  } else {
    const blob = new Blob([content], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  appConfig.lastBackupDate = now.getTime();
  saveConfigToStorage();
  renderCfgForm();
  notify(password ? 'Backup protegido por senha exportado! 🔒' : 'Backup exportado com sucesso!', 'ok');
}

async function importBackup() {
  if (isElectron()) {
    const filePath = await window.electronAPI.openFileDialog({
      title:   'Selecionar arquivo de backup',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!filePath) return;
    const content = await window.electronAPI.readFile(filePath);
    if (!content) { notify('Não foi possível ler o arquivo selecionado.', 'err'); return; }
    _handleImportContent(content);
  } else {
    const input    = document.createElement('input');
    input.type     = 'file';
    input.accept   = '.json';
    input.onchange = e => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader  = new FileReader();
      reader.onload = ev => _handleImportContent(ev.target.result);
      reader.readAsText(file);
    };
    input.click();
  }
}

async function _handleImportContent(content) {
  let parsed;
  try { parsed = JSON.parse(content); } catch { notify('Arquivo inválido — não é um JSON válido.', 'err'); return; }

  // Formato 2 (wrapper com checksum e/ou criptografia)
  if (parsed && parsed._finannza === 'backup') {
    if (parsed.encrypted) {
      if (!isElectron()) { notify('Este backup é protegido por senha — abra no app instalado.', 'warn'); return; }
      _pendingEncryptedBundle = parsed;
      _openBackupPassModal('import');
      return;
    }
    await _verifyAndProcess(parsed);
    return;
  }

  // Legado (payload cru, sem wrapper — backups da v1.1.9 e anteriores)
  if (parsed && Array.isArray(parsed.expenses)) { _processImport(parsed); return; }

  notify('Arquivo inválido — estrutura de backup não reconhecida.', 'err');
}

// Verifica a integridade (checksum) de um backup não-criptografado antes de restaurar.
async function _verifyAndProcess(wrapper) {
  let checksumOk = true;
  if (wrapper.checksum) {
    const payloadStr = JSON.stringify(wrapper.payload);
    if (isElectron()) {
      const res = await window.electronAPI.backupOpen({ encrypted: false, checksum: wrapper.checksum, payloadStr }, '');
      checksumOk = !!(res && res.ok && res.checksumOk);
    } else {
      checksumOk = (await _sha256Subtle(payloadStr)) === wrapper.checksum;
    }
  }
  if (!checksumOk && !confirm('⚠️ A verificação de integridade falhou — o arquivo pode ter sido corrompido ou alterado depois de exportado.\n\nDeseja restaurar mesmo assim?')) return;
  _processImport(wrapper.payload);
}

// Descriptografa um backup protegido por senha e valida a integridade.
async function _decryptAndProcess(password) {
  const bundle = _pendingEncryptedBundle;
  const msg    = document.getElementById('backup-pass-msg');
  if (!bundle) return;
  const res = await window.electronAPI.backupOpen(bundle, password);
  if (!res || !res.ok) { if (msg) msg.textContent = 'Senha incorreta ou arquivo corrompido/adulterado.'; return; }
  let payload;
  try { payload = JSON.parse(res.value); }
  catch { if (msg) msg.textContent = 'Conteúdo inválido após descriptografar.'; return; }
  _pendingEncryptedBundle = null;
  _closeBackupPassModal();
  if (!res.checksumOk && !confirm('⚠️ A verificação de integridade falhou após descriptografar. Restaurar mesmo assim?')) return;
  _processImport(payload);
}

// ─── Modal de senha do backup (export/import) ─────────────────────
let _backupPassMode        = null; // 'export' | 'import'
let _pendingEncryptedBundle = null;

function _openBackupPassModal(mode) {
  _backupPassMode = mode;
  const $ = id => document.getElementById(id);
  $('backup-pass-input').value   = '';
  $('backup-pass-confirm').value = '';
  $('backup-pass-msg').textContent = '';
  if (mode === 'export') {
    $('backup-pass-title').textContent   = '🔒 Exportar backup com senha';
    $('backup-pass-hint').textContent    = 'A senha criptografa o backup (AES-256). Você precisará dela para restaurar — guarde-a bem, não há como recuperá-la se esquecer.';
    $('backup-pass-confirm-row').style.display = '';
    $('backup-pass-ok').textContent      = 'Exportar';
  } else {
    $('backup-pass-title').textContent   = '🔒 Backup protegido por senha';
    $('backup-pass-hint').textContent    = 'Este backup está criptografado. Digite a senha usada ao exportá-lo.';
    $('backup-pass-confirm-row').style.display = 'none';
    $('backup-pass-ok').textContent      = 'Restaurar';
  }
  $('backup-pass-modal').classList.add('open');
  setTimeout(() => $('backup-pass-input').focus(), 50);
}

function _closeBackupPassModal() {
  document.getElementById('backup-pass-modal').classList.remove('open');
  _backupPassMode = null;
  _pendingEncryptedBundle = null;
}

async function _confirmBackupPass() {
  const pass = document.getElementById('backup-pass-input').value;
  const msg  = document.getElementById('backup-pass-msg');
  if (!pass || pass.length < 4) { msg.textContent = 'A senha precisa de ao menos 4 caracteres.'; return; }
  if (_backupPassMode === 'export') {
    if (pass !== document.getElementById('backup-pass-confirm').value) { msg.textContent = 'As senhas não conferem.'; return; }
    _closeBackupPassModal();
    await _exportBackupWith(pass);
  } else {
    await _decryptAndProcess(pass);
  }
}

function _processImport(data) {
  if (!data || !Array.isArray(data.expenses)) {
    notify('Arquivo inválido — estrutura de backup não reconhecida.', 'err');
    return;
  }
  _pendingRestoreData = data;

  const bd   = data.backupDate ? new Date(data.backupDate).toLocaleDateString('pt-BR')                                          : '—';
  const bh   = data.backupDate ? new Date(data.backupDate).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  const lines = [
    `📅 Backup de <strong>${bd}${bh ? ' às ' + bh : ''}</strong>`,
    `🧾 ${data.expenses.length} lançamento(s)`,
    data.cards?.length          ? `💳 ${data.cards.length} cartão(ões)`                           : null,
    data.customCats?.length     ? `🏷️ ${data.customCats.length} categoria(s) personalizada(s)`    : null,
    data.budgets?.length        ? `🎯 ${data.budgets.length} orçamento(s)`                        : null,
    data.fixedExpenses?.length  ? `🔁 ${data.fixedExpenses.length} despesa(s) fixa(s)`            : null,
    data.monthGoals?.length     ? `📊 ${data.monthGoals.length} meta(s) mensal(is)`               : null,
    data.merchantMap && Object.keys(data.merchantMap).length
      ? `🧠 ${Object.keys(data.merchantMap).length} mapeamento(s) aprendido(s)` : null,
    data.acertos?.length        ? `💳 ${data.acertos.length} acerto(s) de contas`                  : null,
  ].filter(Boolean);

  const el = document.getElementById('restore-summary');
  if (el) el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:5px;font-size:13px;margin-bottom:12px">
      ${lines.map(l => `<div>${l}</div>`).join('')}
    </div>
    <div style="background:var(--warn-soft);border:1px solid var(--warn);border-radius:8px;padding:9px 12px;font-size:12px;color:var(--warn)">
      ⚠️ Os dados atuais serão <strong>substituídos</strong>.
      ${isElectron() ? 'Um backup de segurança do estado atual é criado automaticamente (<code>gastos-pre-restore-1..3.json</code>, últimas 3 versões).' : ''}
    </div>`;
  document.getElementById('restore-modal').classList.add('open');
}

// Rotaciona os snapshots de segurança: mantém os 3 mais recentes
// (gastos-pre-restore-1 = mais novo … -3 = mais antigo). Usa só readFile/
// writeFile/fileExists (não precisa de listagem de diretório).
async function _rotatePreRestore(baseDir, newContent) {
  const pathFor = n => window.electronAPI.pathJoin(baseDir, `gastos-pre-restore-${n}.json`);
  const p1 = await pathFor(1), p2 = await pathFor(2), p3 = await pathFor(3);
  // Desloca 2→3 e 1→2 (o -3 antigo é sobrescrito/descartado).
  if (await window.electronAPI.fileExists(p2)) {
    const c = await window.electronAPI.readFile(p2); if (c != null) await window.electronAPI.writeFile(p3, c);
  }
  if (await window.electronAPI.fileExists(p1)) {
    const c = await window.electronAPI.readFile(p1); if (c != null) await window.electronAPI.writeFile(p2, c);
  }
  await window.electronAPI.writeFile(p1, newContent);
}

async function executeRestore() {
  if (!_pendingRestoreData) return;
  const data          = _pendingRestoreData;
  _pendingRestoreData = null;
  closeModal('restore-modal');

  // Safety snapshot of current state (Electron only) — mantém as últimas 3 versões.
  if (isElectron()) {
    try {
      const folder  = appConfig.dataFolderPath;
      const base    = folder || (await window.electronAPI.getDefaultDataPath());
      const snapshot = JSON.stringify(
        { expenses, customCats, budgets, fixedExpenses, cards, monthGoals, merchantMap, acertos, faturaPagamentos, deletedIds: [...deletedExpenseIds] }, null, 2
      );
      await _rotatePreRestore(base, snapshot);
    } catch { /* non-fatal */ }
  }

  const normalized   = migrateData(data);
  expenses           = normalized.expenses;
  customCats         = normalized.customCats;
  budgets            = normalized.budgets;
  fixedExpenses      = normalized.fixedExpenses;
  cards              = normalized.cards;
  monthGoals         = normalized.monthGoals;
  merchantMap        = normalized.merchantMap || {};
  acertos            = normalized.acertos     || [];
  faturaPagamentos   = normalized.faturaPagamentos || [];
  deletedExpenseIds  = new Set((normalized.deletedIds || []).map(String));

  if (normalized.config) {
    // Backups não contêm credenciais — preserva as do dispositivo atual para
    // não zerar o token/secret ao restaurar na mesma máquina.
    const keepLocal = {
      dataFolderPath:  appConfig.dataFolderPath,
      tgToken:         appConfig.tgToken,        tgTokenEnc:      appConfig.tgTokenEnc,
      sheetsSecret:    appConfig.sheetsSecret,   sheetsSecretEnc: appConfig.sheetsSecretEnc,
      appsScriptUrl:   appConfig.appsScriptUrl,
      secretsPlaintextFallback: appConfig.secretsPlaintextFallback,
    };
    appConfig = { ...DEFAULT_CONFIG, ...normalized.config, ...keepLocal };
    saveConfigToStorage();
  }

  await saveAll();
  auditLog({ tipo: 'acao_usuario', categoria: 'backup', acao: 'restaurar', ator: 'Usuário', detalhes: { lancamentos: expenses.length, cartoes: cards.length, acertos: acertos.length, origem: data && data.backupDate ? 'backup' : 'snapshot' } });

  loadConfig();
  await hydrateSecrets();
  refreshAllDynamicSelects();
  renderPersonPills();
  updateMetrics(); renderCharts(); renderRecent(); renderList();
  renderBudgets(); renderBudgetAlerts(); renderDivisao();
  renderFaturas(); renderInvoiceAlerts(); renderCatGrid();
  renderCfgForm(); renderEvolutionChart();
  notify('Backup restaurado com sucesso! 🎉', 'ok');
}

function migrateData(data) {
  // Coage cada campo ao tipo esperado — um backup parcialmente corrompido
  // (ex: customCats:"x") não pode injetar um não-array no estado.
  data.expenses      = asArray(data.expenses);
  data.customCats    = asArray(data.customCats);
  data.budgets       = asArray(data.budgets);
  data.fixedExpenses = asArray(data.fixedExpenses);
  data.cards         = asArray(data.cards);
  data.monthGoals    = asArray(data.monthGoals);
  data.merchantMap   = asObject(data.merchantMap);
  data.acertos       = asArray(data.acertos);
  data.faturaPagamentos = asArray(data.faturaPagamentos);
  data.deletedIds    = asArray(data.deletedIds);
  // Backfill missing mesCompetencia (fallback: purchase month)
  data.expenses.forEach(e => {
    if (e.metodo === 'Crédito' && e.data && !e.mesCompetencia) {
      e.mesCompetencia = (e.data.includes('/') ? parseDateStr(e.data) : e.data).slice(0, 7);
    }
  });
  return data;
}

// ─── BUDGET ───────────────────────────────────────────────────────
function populateBudgetCatSelect() {
  const sel = document.getElementById('bud-cat');
  if (!sel) return;
  sel.innerHTML = getAllCategories().filter(c=>c.id!=='outros').map(c =>
    `<option value="${escapeHtml(c.id)}">${c.icone} ${escapeHtml(c.nome)}</option>`
  ).join('');
}

function parseCurrencyInput(val) {
  return parseFloat(String(val || '').replace(/\./g, '').replace(',', '.')) || 0;
}
function fmtCurrencyInput(num) {
  if (!num && num !== 0) return '';
  return parseFloat(num).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function setupCurrencyInputs() {
  document.querySelectorAll('input[data-currency]').forEach(el => {
    el.addEventListener('input', function() {
      const digits = this.value.replace(/\D/g, '');
      if (!digits) { this.value = ''; return; }
      const cents = parseInt(digits, 10);
      const reais = Math.floor(cents / 100);
      const dec   = cents % 100;
      this.value  = reais.toLocaleString('pt-BR') + ',' + String(dec).padStart(2, '0');
    });
    el.addEventListener('focus', function() { this.select(); });
  });
}

function addBudget() {
  const catId   = document.getElementById('bud-cat').value;
  const limit   = parseCurrencyInput(document.getElementById('bud-limit').value);
  const alertAt = parseFloat(document.getElementById('bud-alert').value) || 80;
  if (!catId || !limit) { notify('Preencha a categoria e o limite.','err'); return; }
  const cat = getAllCategories().find(c=>c.id===catId);
  budgets = budgets.filter(b => !(b.catId===catId && b.month===currentMonth));
  budgets.push({ catId, catNome:cat.nome, catIcone:cat.icone, limit, alertAt, month:currentMonth });
  saveAll(); renderBudgets(); renderBudgetAlerts();
  notify('Orçamento definido!','ok');
}

function deleteBudget(catId) {
  budgets = budgets.filter(b => !(b.catId===catId && b.month===currentMonth));
  saveAll(); renderBudgets(); renderBudgetAlerts();
  notify('Orçamento removido.','info');
}

function renderBudgets() {
  populateBudgetCatSelect();
  renderMonthGoal();
  const monthBudgets = budgets.filter(b => b.month===currentMonth);
  document.getElementById('bud-month-label').textContent = formatMonth(currentMonth);
  const el = document.getElementById('budget-list');
  if (!monthBudgets.length) { el.innerHTML='<div class="empty"><div class="empty-icon">🎯</div>Nenhum orçamento definido.</div>'; renderMonthClosing([]); return; }
  const me = contextMonthExpenses();
  const catSpend = {};
  me.forEach(e => catSpend[e.categoriaId||e.categoria] = (catSpend[e.categoriaId||e.categoria]||0)+e.valor);
  el.innerHTML = monthBudgets.map(b => {
    const spent    = catSpend[b.catId] || 0;
    const pct      = Math.min(100, (spent/b.limit)*100);
    const over     = spent > b.limit;
    const near     = pct >= b.alertAt && !over;
    const cs = getComputedStyle(document.documentElement);
    const barColor = over ? cs.getPropertyValue('--danger').trim() : near ? cs.getPropertyValue('--warn').trim() : cs.getPropertyValue('--success').trim();
    return `<div class="budget-item">
      <div class="budget-row">
        <span class="budget-name">${b.catIcone} ${escapeHtml(b.catNome)}</span>
        <span class="budget-values ${over?'budget-over':''}">${fmt(spent)} / ${fmt(b.limit)} ${over?'⚠️ LIMITE EXCEDIDO':''}</span>
        <button class="btn-icon" onclick="deleteBudget('${escapeHtml(b.catId)}')" title="Remover">🗑</button>
      </div>
      <div class="budget-bar-wrap"><div class="budget-bar-fill" style="width:${pct}%;background:${barColor}"></div></div>
      <div style="font-size:10px;color:var(--muted)">${pct.toFixed(0)}% usado · restam ${fmt(Math.max(0,b.limit-spent))}</div>
    </div>`;
  }).join('');
  renderMonthClosing(monthBudgets, catSpend);
}

function renderMonthClosing(buds, catSpend={}) {
  const me       = contextMonthExpenses();
  const total    = me.reduce((a,e)=>a+e.valor,0);
  const el       = document.getElementById('month-closing');
  if (!me.length) { el.innerHTML='<p>📅 Nenhum gasto registrado neste mês.</p>'; return; }
  const over     = buds.filter(b=>(catSpend[b.catId]||0)>b.limit);
  const [yr,mo]   = currentMonth.split('-');
  const lastDay   = new Date(parseInt(yr),parseInt(mo),0).getDate();
  const todayDate = new Date();
  const todayYM   = todayDate.toISOString().slice(0,7);
  let daysPast, daysLeft;
  if (currentMonth < todayYM) {
    daysPast = lastDay; daysLeft = 0;
  } else if (currentMonth === todayYM) {
    daysPast = Math.max(1, todayDate.getDate());
    daysLeft = Math.max(0, lastDay - todayDate.getDate());
  } else {
    daysPast = 1; daysLeft = lastDay - 1;
  }
  const goal = getMonthGoal(currentMonth);
  let goalHTML = '';
  if (goal) {
    const goalOver  = total > goal.teto;
    const diff      = Math.abs(total - goal.teto);
    const goalColor = goalOver ? 'var(--danger)' : 'var(--success)';
    const goalBg    = goalOver ? 'var(--danger-soft)' : 'var(--success-soft)';
    goalHTML = `<div style="padding:8px 10px;background:${goalBg};border-radius:8px;font-size:12px;color:${goalColor}">
      ${goalOver
        ? `⚠️ Meta ultrapassada em <strong>${fmt(diff)}</strong>`
        : `🎉 Meta cumprida! Ficou abaixo do teto em <strong>${fmt(diff)}</strong>`
      }
    </div>`;
  }
  el.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">
    <div>📊 <strong>Total em ${formatMonth(currentMonth)}:</strong> ${fmt(total)}</div>
    <div>📅 <strong>Dias restantes:</strong> ${daysLeft} dias</div>
    ${total>0?`<div>💡 <strong>Média diária:</strong> ${fmt(total/daysPast)} · Projeção: ${fmt((total/daysPast)*lastDay)}</div>`:''}
    ${over.length?`<div style="color:var(--danger)">⚠️ Acima do limite: ${over.map(b=>escapeHtml(b.catNome)).join(', ')}</div>`:''}
    <div style="padding:10px;background:var(--faint);border-radius:8px;font-size:12px;color:#555;line-height:1.8">
      🪞 <strong>Fechamento:</strong> Você gastou ${fmt(total)}.
      ${over.length?`<span style="color:var(--danger)"> ${over.length} categoria(s) excederam o limite.</span>`:''}
      ${!over.length&&buds.length?' ✅ Dentro do orçamento em todas as categorias!':''}
      ${daysLeft>0?` ${daysLeft} dias restantes — mantenha o foco!`:''}
    </div>
    ${goalHTML}
  </div>`;
}

function renderVariableEstimateAlerts() {
  const el = document.getElementById('variable-estimate-alerts');
  if (!el) return;
  const pending = contextMonthExpenses().filter(e => e.isEstimate === true);
  if (!pending.length) { el.innerHTML = ''; return; }
  const names = pending.slice(0, 3).map(e => escapeHtml(e.descricao)).join(', ');
  const extra = pending.length > 3 ? ` +${pending.length - 3} mais` : '';
  el.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;margin-bottom:10px;background:var(--warn-soft);border:1px solid var(--warn);border-radius:8px;font-size:12px">
    <span style="font-size:16px;flex-shrink:0">📊</span>
    <div>
      <strong>${pending.length}</strong> conta${pending.length>1?'s variáveis aguardam':'  variável aguarda'} confirmação do valor real este mês:
      <span style="color:var(--muted)">${names}${extra}</span>
    </div>
  </div>`;
}

function renderBudgetAlerts() {
  const monthBudgets = budgets.filter(b=>b.month===currentMonth);
  const el = document.getElementById('budget-alerts');
  if (!el||!monthBudgets.length) { if(el) el.innerHTML=''; return; }
  const me = contextMonthExpenses();
  const catSpend = {};
  me.forEach(e => catSpend[e.categoriaId||e.categoria]=(catSpend[e.categoriaId||e.categoria]||0)+e.valor);
  const alerts = monthBudgets.filter(b=>(catSpend[b.catId]||0)>=(b.limit*(b.alertAt/100)));
  el.innerHTML = alerts.map(b => {
    const spent = catSpend[b.catId]||0;
    const over  = spent>b.limit;
    return `<div style="background:${over?'#fef2f2':'#fffbeb'};border:1px solid ${over?'#fca5a5':'#fcd34d'};border-radius:9px;padding:8px 12px;font-size:12px;color:${over?'#b91c1c':'#92400e'};display:flex;justify-content:space-between;align-items:center">
      <span>${over?'🚨':'⚠️'} <strong>${b.catIcone} ${escapeHtml(b.catNome)}:</strong> ${fmt(spent)} de ${fmt(b.limit)} (${((spent/b.limit)*100).toFixed(0)}%)</span>
      <span>${over?'LIMITE EXCEDIDO':'Próximo do limite'}</span>
    </div>`;
  }).join('');
}

// ─── MONTH GOALS ─────────────────────────────────────────────────

function getMonthGoal(month) {
  return monthGoals.find(g => g.month === month) || null;
}

function saveMonthGoal() {
  const teto  = parseCurrencyInput(document.getElementById('goal-teto').value);
  const renda = parseCurrencyInput(document.getElementById('goal-renda').value);
  if (!teto) { notify('Informe o teto de gastos.', 'err'); return; }
  monthGoals = monthGoals.filter(g => g.month !== currentMonth);
  monthGoals.push({ month: currentMonth, teto, renda: renda || 0 });
  saveAll();
  renderMonthGoal();
  updateMetrics();
  notify('Meta salva!', 'ok');
}

function deleteMonthGoal() {
  monthGoals = monthGoals.filter(g => g.month !== currentMonth);
  saveAll();
  renderMonthGoal();
  updateMetrics();
  notify('Meta removida.', 'info');
}

function copyGoalFromPrevMonth() {
  const [yr, mo] = currentMonth.split('-');
  const moNum    = parseInt(mo);
  const prevMonth = moNum === 1
    ? `${parseInt(yr) - 1}-12`
    : `${yr}-${String(moNum - 1).padStart(2, '0')}`;
  const prev      = getMonthGoal(prevMonth);
  if (!prev) return;
  monthGoals = monthGoals.filter(g => g.month !== currentMonth);
  monthGoals.push({ ...prev, month: currentMonth });
  saveAll();
  renderMonthGoal();
  updateMetrics();
  notify(`Meta copiada de ${formatMonth(prevMonth)}!`, 'ok');
}

function renderMonthGoal() {
  const goal = getMonthGoal(currentMonth);
  const el   = document.getElementById('month-goal-content');
  const lbl  = document.getElementById('goal-month-label');
  if (!el) return;
  if (lbl) lbl.textContent = formatMonth(currentMonth);

  const me       = contextMonthExpenses();
  const total    = me.reduce((a, e) => a + e.valor, 0);
  const [yr, mo] = currentMonth.split('-');
  const lastDay  = new Date(parseInt(yr), parseInt(mo), 0).getDate();
  const todayDate = new Date();
  const todayYM   = todayDate.toISOString().slice(0, 7);
  let daysPast;
  if (currentMonth < todayYM)      { daysPast = lastDay; }
  else if (currentMonth === todayYM) { daysPast = Math.max(1, todayDate.getDate()); }
  else                               { daysPast = 1; }
  const projected = (total / daysPast) * lastDay;

  const moNum    = parseInt(mo);
  const prevMonth = moNum === 1
    ? `${parseInt(yr) - 1}-12`
    : `${yr}-${String(moNum - 1).padStart(2, '0')}`;
  const prevGoal  = getMonthGoal(prevMonth);

  let progressHTML = '';
  if (goal) {
    const pct      = Math.min(100, (total / goal.teto) * 100);
    const over     = total > goal.teto;
    const near     = pct >= 70 && !over;
    const cs       = getComputedStyle(document.documentElement);
    const barColor = over ? cs.getPropertyValue('--danger').trim()
                   : near ? cs.getPropertyValue('--warn').trim()
                   :        cs.getPropertyValue('--success').trim();
    const restam   = Math.max(0, goal.teto - total);
    let economiaHTML = '';
    if (goal.renda > 0) {
      const econ      = goal.renda - projected;
      const econColor = econ >= 0 ? 'var(--success)' : 'var(--danger)';
      economiaHTML    = `<div style="color:${econColor}">💰 Economia projetada: <strong>${fmt(econ)}</strong></div>`;
    }
    progressHTML = `<div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
        <span style="font-size:11px;color:var(--muted)">${pct.toFixed(0)}% do teto</span>
        <span style="font-size:12px;font-weight:600;color:${over?'var(--danger)':'var(--text)'}">${fmt(total)} / ${fmt(goal.teto)}</span>
      </div>
      <div style="background:var(--faint);border-radius:4px;height:8px;overflow:hidden;margin-bottom:8px">
        <div style="height:100%;background:${barColor};width:${pct}%;border-radius:4px;transition:width .3s"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;font-size:12px">
        <div>Gastou <strong>${fmt(total)}</strong> de <strong>${fmt(goal.teto)}</strong> · restam <strong style="color:${over?'var(--danger)':'var(--success)'}">${fmt(restam)}</strong></div>
        ${economiaHTML}
      </div>
    </div>`;
  }

  const tetoVal  = goal ? fmtCurrencyInput(goal.teto)       : '';
  const rendaVal = goal ? fmtCurrencyInput(goal.renda || 0) : '';
  const deleteBtn = goal
    ? `<button class="btn" style="color:var(--danger);border-color:var(--danger)" onclick="deleteMonthGoal()">🗑 Remover</button>`
    : '';
  const copyBtn = !goal && prevGoal
    ? `<div style="margin-top:8px"><button class="btn btn-secondary" onclick="copyGoalFromPrevMonth()">📋 Copiar meta de ${escapeHtml(formatMonth(prevMonth))}</button></div>`
    : '';

  el.innerHTML = `${progressHTML}
    <div class="form-row cols2" style="margin-bottom:10px">
      <div>
        <label>Teto de gastos do mês (R$)</label>
        <input type="text" id="goal-teto" data-currency="true" placeholder="0,00" inputmode="numeric" value="${tetoVal}" />
      </div>
      <div>
        <label>Renda mensal do casal (R$) <span style="font-size:10px;color:var(--muted)">— opcional</span></label>
        <input type="text" id="goal-renda" data-currency="true" placeholder="0,00" inputmode="numeric" value="${rendaVal}" />
      </div>
    </div>
    <div class="btn-row" style="margin:0">
      <button class="btn btn-primary" onclick="saveMonthGoal()">💾 ${goal ? 'Atualizar meta' : 'Definir meta'}</button>
      ${deleteBtn}
    </div>
    ${copyBtn}`;
  setupCurrencyInputs();
}

// ─── FIXED / RECURRING EXPENSES ──────────────────────────────────
function populateFixedCatSelect() {
  const sel = document.getElementById('fixed-cat');
  if (!sel) return;
  sel.innerHTML = getAllCategories().filter(c=>c.id!=='outros').map(c =>
    `<option value="${escapeHtml(c.id)}">${c.icone} ${escapeHtml(c.nome)}</option>`
  ).join('');
}

function populateFixedPersonSelect() {
  const sel = document.getElementById('fixed-person');
  if (!sel) return;
  sel.innerHTML = getPersons().map(p =>
    `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`
  ).join('');
}

// ─── VARIÁVEL EXPENSE HELPERS ─────────────────────────────────────
// Returns the average of the last ≤6 confirmed (non-estimate) values for a
// fixedExpense template, or null when there is no history yet.
function _calcVariavelEstimate(fixedId) {
  const confirmed = expenses
    .filter(e => e.fixedId == fixedId && e.isEstimate !== true && e.valor > 0)
    .sort((a, b) => parseDateStr(b.data).localeCompare(parseDateStr(a.data)))
    .slice(0, 6);
  if (!confirmed.length) return null;
  return confirmed.reduce((s, e) => s + e.valor, 0) / confirmed.length;
}

function sparklineSVG(values, width = 80, height = 24) {
  if (values.length < 2) return '';
  const min   = Math.min(...values);
  const max   = Math.max(...values);
  const range = max - min || max * 0.1 || 1;
  const pts   = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - 4) + 2;
    const y = height - 2 - ((v - min) / range) * (height - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg width="${width}" height="${height}" style="display:inline-block;vertical-align:middle;overflow:visible">` +
    `<polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// Returns '↑', '↓', or '→' based on recent vs. older values (input is newest-first).
function _calcTrend(values) {
  if (values.length < 4) return '→';
  const recent = values.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  const older  = values.slice(3).reduce((a, b) => a + b, 0) / values.slice(3).length;
  const pct    = (recent - older) / (older || 1);
  if (pct >  0.05) return '↑';
  if (pct < -0.05) return '↓';
  return '→';
}

function updateFixedTipoForm() {
  const tipo = document.querySelector('input[name="fixed-tipo"]:checked')?.value || 'fixa';
  const lbl  = document.getElementById('fixed-valor-label');
  const hint = document.getElementById('fixed-valor-hint');
  if (tipo === 'variavel') {
    if (lbl)  lbl.textContent  = 'Estimativa inicial (R$, opcional)';
    if (hint) hint.textContent = 'Deixe em branco — sistema calcula da média histórica.';
  } else {
    if (lbl)  lbl.textContent  = 'Valor (R$)';
    if (hint) hint.textContent = '';
  }
}

function addFixed() {
  const tipo      = document.querySelector('input[name="fixed-tipo"]:checked')?.value || 'fixa';
  const descricao = document.getElementById('fixed-desc').value.trim();
  const valorRaw  = parseCurrencyInput(document.getElementById('fixed-valor').value);
  const valor     = valorRaw || 0;
  const dia       = Math.min(28, Math.max(1, parseInt(document.getElementById('fixed-dia').value) || 1));
  const catId     = document.getElementById('fixed-cat').value;
  const pessoa    = document.getElementById('fixed-person').value;
  const metodo    = document.getElementById('fixed-method').value;
  if (!descricao || !catId) { notify('Preencha descrição e categoria.', 'err'); return; }
  if (tipo === 'fixa' && !valor) { notify('Preencha o valor para despesas fixas.', 'err'); return; }
  const cat = getAllCategories().find(c=>c.id===catId);
  if (!cat) return;
  fixedExpenses.push({ id: Date.now()+Math.random(), descricao, valor, dia, pessoa, metodo,
    categoria:cat.nome, categoriaId:cat.id, icone:cat.icone, cor:cat.cor, ativo:true, contexto:currentContext, tipo });
  saveAll(); renderFixedList();
  document.getElementById('fixed-desc').value  = '';
  document.getElementById('fixed-valor').value = '';
  document.getElementById('fixed-dia').value   = '1';
  const tipoFixa = document.getElementById('fixed-tipo-fixa');
  if (tipoFixa) { tipoFixa.checked = true; updateFixedTipoForm(); }
  notify(`"${descricao}" adicionada!`, 'ok');
}

function toggleFixedActive(id) {
  const f = fixedExpenses.find(x=>x.id===id);
  if (!f) return;
  f.ativo = f.ativo === false;
  saveAll(); renderFixedList();
}

function deleteFixed(id) {
  if (!confirm('Remover esta despesa fixa?')) return;
  fixedExpenses = fixedExpenses.filter(f=>f.id!==id);
  saveAll(); renderFixedList();
  notify('Despesa fixa removida.','info');
}

function _autoGenerateFixed() {
  const active = fixedExpenses.filter(f=>f.ativo!==false && (!f.contexto||f.contexto===currentContext));
  if (!active.length) return 0;
  const me = contextMonthExpenses();
  const [yr, mo] = currentMonth.split('-');
  let generated = 0;
  active.forEach(f => {
    if (me.some(e=>e.fixedId===f.id)) return;

    let valorGerado = f.valor || 0;
    const variavelFields = {};

    if (f.tipo === 'variavel') {
      const avg = _calcVariavelEstimate(f.id);
      valorGerado = avg !== null ? parseFloat(avg.toFixed(2)) : (f.valor || 0);
      if (!valorGerado) return; // no history and no initial estimate — skip
      variavelFields.isEstimate    = true;
      variavelFields.valorEstimado = valorGerado;
    }

    const lastDay = new Date(parseInt(yr), parseInt(mo), 0).getDate();
    const day     = Math.min(f.dia||1, lastDay);
    const date    = new Date(parseInt(yr), parseInt(mo)-1, day);
    expenses.unshift({
      id: Date.now()+Math.random()+generated, descricao:f.descricao, valor:valorGerado,
      categoria:f.categoria, categoriaId:f.categoriaId, icone:f.icone, cor:f.cor,
      pessoa:f.pessoa, mensagem:'[Despesa fixa]', confianca:100,
      data:date.toLocaleDateString('pt-BR'), ts:date.getTime(),
      metodo:f.metodo||'', installment:null, splitOf:null, splitPct:null,
      fixedId:f.id, ...variavelFields, contexto:currentContext,
    });
    generated++;
  });
  if (generated > 0) saveAll();
  return generated;
}

function generateFixedForMonth() {
  const active = fixedExpenses.filter(f=>f.ativo!==false && (!f.contexto||f.contexto===currentContext));
  if (!active.length) { notify('Nenhuma despesa fixa ativa cadastrada.','info'); return; }
  const generated = _autoGenerateFixed();
  if (generated > 0) {
    updateMetrics(); renderRecent(); renderList(); renderBudgetAlerts(); renderFixedList();
    notify(`${generated} despesa(s) fixa(s) gerada(s) para ${formatMonth(currentMonth)}!`, 'ok');
  } else {
    notify('Todas as despesas fixas já foram geradas para este mês.', 'info');
  }
}

function renderFixedList() {
  const ctx = fixedExpenses.filter(f=>!f.contexto||f.contexto===currentContext);
  const el  = document.getElementById('fixed-list');
  if (!ctx.length) { el.innerHTML='<div class="empty"><div class="empty-icon">🔁</div>Nenhuma despesa fixa cadastrada.</div>'; return; }
  const me = contextMonthExpenses();
  el.innerHTML = ctx.map(f => {
    const pc           = personColor(f.pessoa);
    const genEntry     = me.find(e=>e.fixedId===f.id);
    const generated    = !!genEntry;
    const isEstEntry   = genEntry?.isEstimate === true;
    const inactive     = f.ativo === false;
    const isVariavel   = f.tipo === 'variavel';

    let statusBadge;
    if (!generated) {
      statusBadge = `<span class="badge" style="background:#fff7ed;color:#c2410c">Pendente este mês</span>`;
    } else if (isEstEntry) {
      statusBadge = `<span class="badge" style="background:#fef9c3;color:#854d0e">📊 Estimativa gerada</span>`;
    } else {
      statusBadge = `<span class="badge" style="background:#dcfce7;color:#16a34a">✓ Gerada ${formatMonth(currentMonth)}</span>`;
    }

    let variavelStats = '';
    let amountDisplay = fmt(f.valor || 0);

    if (isVariavel) {
      const history = expenses
        .filter(e => e.fixedId === f.id && e.isEstimate !== true && e.valor > 0)
        .sort((a, b) => parseDateStr(b.data).localeCompare(parseDateStr(a.data)))
        .slice(0, 6);
      const estimate = history.length
        ? parseFloat((history.reduce((s,e)=>s+e.valor,0)/history.length).toFixed(2))
        : (f.valor || null);
      amountDisplay = estimate !== null ? `~${fmt(estimate)}` : '—';

      if (history.length >= 2) {
        const vals  = history.map(e=>e.valor).reverse(); // oldest → newest for sparkline
        const mini  = Math.min(...vals);
        const maxi  = Math.max(...vals);
        const trend = _calcTrend(history.map(e=>e.valor));
        const tCol  = trend==='↑'?'var(--danger)':trend==='↓'?'var(--success)':'var(--muted)';
        const nMeses = history.length < 6
          ? `<span style="color:var(--warn)">(${history.length}m)</span>` : '(6m)';
        variavelStats = `
          <div style="margin-top:6px;padding:7px 10px;background:var(--faint);border-radius:6px;border:1px solid var(--border)">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              ${sparklineSVG(vals)}
              <div style="font-size:10px;color:var(--muted);line-height:1.8">
                méd. <strong style="color:var(--text)">${fmt(estimate)}</strong> · mín ${fmt(mini)} · máx ${fmt(maxi)}
                <span style="color:${tCol};font-weight:700;margin-left:4px">${trend}</span>
              </div>
            </div>
            <div style="font-size:10px;color:var(--muted);margin-top:2px">
              Estimativa próximo mês: <strong style="color:var(--text)">${fmt(estimate)}</strong> ${nMeses}
            </div>
          </div>`;
      } else if (history.length === 1) {
        variavelStats = `<div style="margin-top:4px;font-size:10px;color:var(--muted)">1 valor confirmado · mais dados em construção.</div>`;
      } else {
        variavelStats = `<div style="margin-top:4px;font-size:10px;color:var(--muted)">Sem histórico ainda. Confirme o valor ao receber a conta.</div>`;
      }
    }

    return `<div class="expense-item" style="${inactive?'opacity:.55':''}">
      <div class="expense-icon" style="background:${escapeHtml(f.cor||'#eee')}22">${f.icone||'📦'}</div>
      <div class="expense-main" style="min-width:0">
        <div class="expense-desc">
          ${escapeHtml(f.descricao)}
          ${isVariavel?`<span class="badge" style="background:#e0f2fe;color:#0369a1;font-size:9px;vertical-align:middle">📊 variável</span>`:''}
        </div>
        <div class="expense-meta">
          <span class="badge" style="background:${escapeHtml(f.cor||'#eee')}22;color:${escapeHtml(f.cor||'#888')}">${escapeHtml(f.categoria)}</span>
          <span class="badge-person" style="background:${pc}22;color:${pc}">${escapeHtml(f.pessoa)}</span>
          <span>Todo dia ${f.dia||1}</span>
          ${f.metodo?`<span>${METHOD_ICONS[f.metodo]||''} ${escapeHtml(f.metodo)}</span>`:''}
          ${statusBadge}
          ${inactive?`<span class="badge" style="background:#f1f5f9;color:#64748b">Pausada</span>`:''}
        </div>
        ${variavelStats}
      </div>
      <div class="expense-amount">${amountDisplay}</div>
      <div class="expense-actions">
        <button class="btn-icon" onclick="toggleFixedActive(${f.id})" title="${inactive?'Ativar':'Pausar'}">${inactive?'▶️':'⏸️'}</button>
        <button class="btn-icon" onclick="deleteFixed(${f.id})" title="Remover">🗑</button>
      </div>
    </div>`;
  }).join('');
}

// ─── DIVISÃO ──────────────────────────────────────────────────────
// ─── DIVISÃO POR FATURA ───────────────────────────────────────────
// O pagador é propriedade da FATURA DE CADA MÊS (não do cartão): quem quita a
// fatura do cartão do Casal varia mês a mês. Cada fatura do Casal (cartão de
// crédito com dono === coupleName, agrupada por mês de competência) tem um
// registro em faturaPagamentos com a forma de pagamento. Ausência = "dividido".

const _isCoupleCard = c => c && c.dono === appConfig.coupleName;
function _coupleCardIds() {
  return new Set(cards.filter(_isCoupleCard).map(c => c.id));
}

// Resolve quanto cada um pagou de uma fatura (cardId + mês), dado o total atual.
// dividido/p1/p2 são recalculados do total vigente; personalizado usa os valores
// salvos. Retorna { formaPagamento, valorGabriel, valorAnna, pago, dataPagamento, rec }.
function _faturaSplit(cardId, mesComp, total) {
  const rec = faturaPagamentos.find(f =>
    f.cardId === cardId && f.mesCompetencia === mesComp &&
    (!f.contexto || f.contexto === currentContext));
  const half = Math.round((total / 2) * 100) / 100;
  const base = { pago: rec?.pago || false, dataPagamento: rec?.dataPagamento || '', rec };
  const forma = rec?.formaPagamento || 'dividido';
  if (forma === 'p1')            return { formaPagamento:'p1',            valorGabriel: total, valorAnna: 0,     ...base };
  if (forma === 'p2')            return { formaPagamento:'p2',            valorGabriel: 0,     valorAnna: total, ...base };
  if (forma === 'personalizado') return { formaPagamento:'personalizado', valorGabriel: Number(rec.valorGabriel)||0, valorAnna: Number(rec.valorAnna)||0, ...base };
  return { formaPagamento:'dividido', valorGabriel: half, valorAnna: total - half, ...base };
}

// Um gasto do Casal é "manual" (não-fatura) quando NÃO é crédito num cartão do
// Casal — esses vivem fora do modelo de faturaPagamentos e podem ter um pagador
// individual em e.pagoPor (p1Name | p2Name | '' = dividido).
function _isManualCoupleExpense(e) {
  if (!e || e.pessoa !== appConfig.coupleName) return false;
  return !(e.metodo === 'Crédito' && e.cardId && _coupleCardIds().has(e.cardId));
}

// Agrupa os gastos do Casal de um mês em faturas (cartão do Casal) e gastos
// manuais, e soma quanto cada um adiantou. Gastos manuais do Casal (não-fatura)
// pagos por uma pessoa só (e.pagoPor) contam 100% para essa pessoa; sem pagoPor
// são tratados como divididos (metade cada → sem dívida).
//
// Toda a soma é feita em CENTAVOS INTEIROS para eliminar o erro de ponto
// flutuante (ex: 1300.00 saindo do reduce como 1300.0000000002, que gerava um
// fantasma de R$ 0,01 no acumulado). Além disso, "dividido" é 50/50 EXATO: soma
// metades idênticas aos dois lados, então NÃO gera dívida nenhuma — nem quando o
// total tem centavo ímpar (sem o viés antigo de o centavo extra ir sempre p/ p1).
function _monthCouplePaid(sharedExp, mesComp) {
  const p1 = appConfig.p1Name, p2 = appConfig.p2Name;
  const coupleIds = _coupleCardIds();
  const toC = v => Math.round((Number(v) || 0) * 100); // reais → centavos inteiros
  const byCard = {};
  let manualTotalC = 0, manualP1C = 0, manualP2C = 0, manualSplitC = 0;
  for (const e of sharedExp) {
    if (e.metodo === 'Crédito' && e.cardId && coupleIds.has(e.cardId)) {
      (byCard[e.cardId] = byCard[e.cardId] || []).push(e);
    } else {
      const v = toC(e.valor);
      manualTotalC += v;
      if      (e.pagoPor === p1) manualP1C += v;
      else if (e.pagoPor === p2) manualP2C += v;
      else                       manualSplitC += v;
    }
  }
  let p1C = 0, p2C = 0; // podem carregar .5 no caso dividido (simétrico → dívida 0)
  const faturas = [];
  for (const cardId of Object.keys(byCard)) {
    const totalC = byCard[cardId].reduce((s, e) => s + toC(e.valor), 0);
    const total  = totalC / 100;
    const sp = _faturaSplit(cardId, mesComp, total);
    if (sp.formaPagamento === 'dividido') {
      const halfC = totalC / 2;         // 50/50 exato — metade idêntica p/ cada, sem dívida
      p1C += halfC; p2C += halfC;
    } else {
      p1C += toC(sp.valorGabriel);      // p1 / p2 / personalizado — valores exatos em centavos
      p2C += toC(sp.valorAnna);
    }
    faturas.push({ cardId, card: cards.find(c => c.id === cardId), total, count: byCard[cardId].length, mesComp, ...sp });
  }
  const manualHalfC = manualSplitC / 2; // pote manual dividido: metade idêntica → sem dívida
  p1C += manualP1C + manualHalfC;
  p2C += manualP2C + manualHalfC;
  return {
    p1Paid: p1C / 100, p2Paid: p2C / 100, faturas,
    manualTotal: manualTotalC / 100, manualP1: manualP1C / 100,
    manualP2: manualP2C / 100, manualSplit: manualSplitC / 100,
  };
}

function _calcAnnualBalance(year) {
  const p1 = appConfig.p1Name, p2 = appConfig.p2Name;
  const months = Array.from({length: 12}, (_, i) => `${year}-${String(i+1).padStart(2,'0')}`);
  const MON_NAMES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  // Acumula tudo em CENTAVOS INTEIROS para não acumular erro de float mês a mês.
  let runningC = 0; // positive = p1 paid more (p2 owes p1), negative = p2 paid more
  const rows = [], yearAcertos = acertos.filter(a => {
    if (!a.data) return false;
    if (a.contexto && a.contexto !== currentContext) return false;
    const d = a.data.includes('/') ? parseDateStr(a.data) : a.data;
    return d.startsWith(year);
  });
  let annualP1C = 0, annualP2C = 0;
  for (let i = 0; i < months.length; i++) {
    const month = months[i];
    const monthExp = expenses.filter(e => {
      if (!e.data) return false;
      const mk = (e.metodo === 'Crédito' && e.mesCompetencia)
        ? e.mesCompetencia
        : (e.data.includes('/') ? parseDateStr(e.data) : e.data).slice(0, 7);
      return mk === month && (!e.contexto || e.contexto === currentContext);
    });
    // Only shared ("Casal") expenses enter the couple's division. Personal expenses
    // (pessoa === p1/p2) are 100% that person's own responsibility — never split.
    const sharedExp = monthExp.filter(e => e.pessoa === appConfig.coupleName);
    const { p1Paid, p2Paid } = _monthCouplePaid(sharedExp, month);
    // Metades simétricas (dividido/manual) arredondam igual dos dois lados → diff 0.
    const p1C = Math.round(p1Paid * 100), p2C = Math.round(p2Paid * 100);
    const monthDiffC = p1C - p2C;
    runningC += monthDiffC;
    const monthAcertos = yearAcertos.filter(a => {
      const d = a.data.includes('/') ? parseDateStr(a.data) : a.data;
      return d.startsWith(month);
    });
    for (const a of monthAcertos) {
      const av = Math.round((Number(a.valor) || 0) * 100);
      if (a.de === p2) runningC -= av;       // p2 settles debt to p1
      else if (a.de === p1) runningC += av;  // p1 settles debt to p2
    }
    annualP1C += p1C;
    annualP2C += p2C;
    rows.push({ month, label: MON_NAMES[i], p1Paid: p1C / 100, p2Paid: p2C / 100, diff: monthDiffC / 100, balance: runningC / 100, acertos: monthAcertos, hasData: p1C > 0 || p2C > 0 || monthAcertos.length > 0 });
  }
  return { rows, annualP1: annualP1C / 100, annualP2: annualP2C / 100, finalBalance: runningC / 100 };
}

function renderAnnualBalance() {
  const el = document.getElementById('annual-balance');
  if (!el) return;
  if (!_annualYear) _annualYear = currentMonth.split('-')[0];
  const year = _annualYear;
  const titleEl = document.getElementById('annual-balance-year');
  if (titleEl) titleEl.textContent = year;
  const p1 = appConfig.p1Name, p2 = appConfig.p2Name;
  const { rows, annualP1, annualP2, finalBalance } = _calcAnnualBalance(year);
  const settlement   = Math.abs(finalBalance) / 2;
  const annualTotal  = annualP1 + annualP2;
  const currentYear  = currentMonth.split('-')[0];

  let html = `<div style="font-size:12px;color:var(--muted);margin-bottom:10px">
    ${escapeHtml(p1)} adiantou <strong>${fmt(annualP1)}</strong> em gastos do Casal ·
    ${escapeHtml(p2)} adiantou <strong>${fmt(annualP2)}</strong>`;
  if (annualTotal > 0) html += ` · Total Casal: <strong>${fmt(annualTotal)}</strong>`;
  html += `</div>`;

  if (annualTotal > 0) {
    if (Math.abs(finalBalance) > 0.01) {
      const debtor   = finalBalance > 0 ? escapeHtml(p2) : escapeHtml(p1);
      const creditor = finalBalance > 0 ? escapeHtml(p1) : escapeHtml(p2);
      html += `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:9px;padding:10px 14px;margin-bottom:12px">
        <div style="font-size:12px;color:var(--muted)">Diferença acumulada: <strong>${fmt(Math.abs(finalBalance))}</strong></div>
        <div style="font-size:13px;font-weight:600;color:var(--success);margin-top:4px">💸 <strong>${debtor}</strong> deve <strong class="split-balance-pos">${fmt(settlement)}</strong> para <strong>${creditor}</strong></div>
        <button class="btn btn-primary" style="font-size:11px;margin-top:8px" onclick="openAcertoModal()">💳 Registrar acerto</button>
      </div>`;
    } else {
      html += `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:9px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:var(--success)">
        ✅ Saldo zerado — contas equilibradas no ano!
        <button class="btn btn-secondary" style="font-size:11px;margin-left:10px" onclick="openAcertoModal()">💳 Registrar acerto</button>
      </div>`;
    }
  }

  // Month table — only show months up to current month for the current year
  const cutoff = year === currentYear ? currentMonth : `${year}-12`;
  const visibleRows = rows.filter(r => r.month <= cutoff);
  if (!visibleRows.some(r => r.hasData)) {
    html += '<div class="empty"><div class="empty-icon">📊</div>Nenhum dado para este ano.</div>';
  } else {
    html += `<div style="overflow-x:auto"><table class="report-table" style="width:100%;font-size:12px">
      <thead><tr>
        <th>Mês</th><th>${escapeHtml(p1)} pagou</th><th>${escapeHtml(p2)} pagou</th>
        <th>Diferença</th><th>Saldo acum.</th>
      </tr></thead><tbody>`;
    for (const row of visibleRows) {
      const diffAbs   = Math.abs(row.diff);
      const diffSign  = row.diff > 0.01 ? '+' : '';
      const diffColor = row.diff > 0.01 ? 'var(--blue)' : (row.diff < -0.01 ? 'var(--pink)' : 'var(--muted)');
      const balAbs    = Math.abs(row.balance);
      const balSign   = row.balance > 0.01 ? '+' : '';
      const balColor  = balAbs < 0.01 ? 'var(--success)' : (row.balance > 0 ? 'var(--blue)' : 'var(--pink)');
      html += `<tr style="opacity:${row.hasData ? '1' : '0.35'}">
        <td><strong>${row.label}</strong></td>
        <td>${row.p1Paid > 0.001 ? fmt(row.p1Paid) : '—'}</td>
        <td>${row.p2Paid > 0.001 ? fmt(row.p2Paid) : '—'}</td>
        <td style="color:${diffColor};font-weight:600">${diffAbs > 0.01 ? diffSign + fmt(diffAbs) : '—'}</td>
        <td style="color:${balColor};font-weight:600">${balAbs > 0.01 ? balSign + fmt(balAbs) : '✓ 0'}</td>
      </tr>`;
      for (const a of row.acertos) {
        html += `<tr style="background:var(--faint)">
          <td colspan="4" style="font-size:11px;color:var(--success);padding-left:20px">
            💳 Acerto: ${escapeHtml(a.de)} → ${escapeHtml(a.para)} ${fmt(a.valor)}${a.nota ? ` · <em>${escapeHtml(a.nota)}</em>` : ''}
            <button style="font-size:10px;margin-left:6px;background:none;border:none;color:var(--danger);cursor:pointer" data-acid="${a.id}" onclick="deleteAcerto(this.dataset.acid)">🗑</button>
          </td>
          <td style="font-size:11px;color:var(--success);font-weight:600">após acerto</td>
        </tr>`;
      }
    }
    html += '</tbody></table></div>';
  }
  el.innerHTML = html;
}

function navAnnualYear(dir) {
  _annualYear = String(parseInt(_annualYear || currentMonth.split('-')[0]) + dir);
  const titleEl = document.getElementById('annual-balance-year');
  if (titleEl) titleEl.textContent = _annualYear;
  renderAnnualBalance();
}

function openAcertoModal() {
  const year = _annualYear || currentMonth.split('-')[0];
  const { finalBalance } = _calcAnnualBalance(year);
  const p1 = appConfig.p1Name, p2 = appConfig.p2Name;
  const settlement = Math.abs(finalBalance) / 2;
  const de   = finalBalance > 0 ? p2 : p1;
  const para = finalBalance > 0 ? p1 : p2;
  const optsEl = document.getElementById('acerto-direction-opts');
  if (optsEl) {
    optsEl.innerHTML = [
      [p2, p1, de === p2], [p1, p2, de === p1]
    ].map(([from, to, checked]) =>
      `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:6px 10px;border-radius:7px;border:1px solid var(--border);${checked ? 'background:var(--faint);font-weight:600' : ''}">
        <input type="radio" name="acerto-dir" value="${escapeHtml(from)}|${escapeHtml(to)}" ${checked ? 'checked' : ''} />
        ${escapeHtml(from)} paga ${escapeHtml(to)}
      </label>`
    ).join('');
  }
  const valEl = document.getElementById('acerto-valor');
  if (valEl) valEl.value = fmtCurrencyInput(settlement);
  const dtEl = document.getElementById('acerto-data');
  if (dtEl) dtEl.value = today();
  document.getElementById('acerto-nota').value = '';
  document.getElementById('acerto-modal').classList.add('open');
}

function confirmarAcerto() {
  const dirSel = document.querySelector('input[name="acerto-dir"]:checked');
  if (!dirSel) { notify('Selecione a direção do pagamento.', 'err'); return; }
  const [de, para] = dirSel.value.split('|');
  const valor = parseCurrencyInput(document.getElementById('acerto-valor').value);
  const dataISO = document.getElementById('acerto-data').value;
  const nota  = document.getElementById('acerto-nota').value.trim();
  if (!valor || !dataISO) { notify('Preencha valor e data.', 'err'); return; }
  const dataBR = dataISO.split('-').reverse().join('/');
  const acerto = { id: String(Date.now() + Math.random()), de, para, valor, data: dataBR, nota, contexto: currentContext, criadoEm: new Date().toISOString() };
  acertos.push(acerto);
  auditLog({ tipo: 'acao_usuario', categoria: 'divisao', acao: 'acerto', ator: de, detalhes: { de, para, valor, data: dataBR, nota } });
  saveAll();
  document.getElementById('acerto-modal').classList.remove('open');
  renderAnnualBalance();
  notify(`Acerto registrado: ${fmt(valor)}`, 'ok');
}

function deleteAcerto(id) {
  const alvo = acertos.find(a => String(a.id) === String(id));
  acertos = acertos.filter(a => String(a.id) !== String(id));
  auditLog({ tipo: 'acao_usuario', categoria: 'divisao', acao: 'acerto-excluir', ator: alvo?.de || 'Usuário', antes: alvo ? { de: alvo.de, para: alvo.para, valor: alvo.valor, data: alvo.data } : null });
  saveAll();
  renderAnnualBalance();
}

// Localiza (ou cria) o registro de pagamento de uma fatura do mês corrente.
function _getOrCreateFaturaPag(cardId, mesComp) {
  let rec = faturaPagamentos.find(f => f.cardId === cardId && f.mesCompetencia === mesComp &&
    (!f.contexto || f.contexto === currentContext));
  if (!rec) {
    rec = { cardId, mesCompetencia: mesComp, formaPagamento: 'dividido',
      valorGabriel: 0, valorAnna: 0, pago: false, dataPagamento: '', contexto: currentContext };
    faturaPagamentos.push(rec);
  }
  return rec;
}

function setFaturaForma(cardId, mesComp, forma) {
  const rec = _getOrCreateFaturaPag(cardId, mesComp);
  const formaAntes = rec.formaPagamento;
  rec.formaPagamento = forma;
  if (forma === 'personalizado' && !(rec.valorGabriel || rec.valorAnna)) {
    const shared = contextMonthExpenses().filter(e => e.pessoa === appConfig.coupleName);
    const f = _monthCouplePaid(shared, mesComp).faturas.find(x => x.cardId === cardId);
    const half = f ? Math.round((f.total/2)*100)/100 : 0;
    rec.valorGabriel = half; rec.valorAnna = f ? f.total - half : 0;
  }
  const card = cards.find(c => c.id === cardId);
  auditLog({ tipo: 'acao_usuario', categoria: 'divisao', acao: 'forma-pagamento', ator: 'Usuário', detalhes: { cartao: card?.nome || cardId, mesCompetencia: mesComp }, antes: { formaPagamento: formaAntes }, depois: { formaPagamento: forma } });
  saveAll();
  renderDivisao();
}

function saveFaturaPersonalizado(cardId, mesComp) {
  const rec = _getOrCreateFaturaPag(cardId, mesComp);
  rec.formaPagamento = 'personalizado';
  rec.valorGabriel = parseCurrencyInput(document.getElementById('fat-vg-' + cardId)?.value);
  rec.valorAnna    = parseCurrencyInput(document.getElementById('fat-va-' + cardId)?.value);
  const card = cards.find(c => c.id === cardId);
  auditLog({ tipo: 'acao_usuario', categoria: 'divisao', acao: 'valores-personalizados', ator: 'Usuário', detalhes: { cartao: card?.nome || cardId, mesCompetencia: mesComp }, depois: { valorGabriel: rec.valorGabriel, valorAnna: rec.valorAnna } });
  saveAll();
  renderDivisao();
  notify('Valores da fatura salvos.', 'ok');
}

function toggleFaturaPago(cardId, mesComp) {
  const rec = _getOrCreateFaturaPag(cardId, mesComp);
  rec.pago = !rec.pago;
  rec.dataPagamento = rec.pago ? new Date().toLocaleDateString('pt-BR') : '';
  const card = cards.find(c => c.id === cardId);
  auditLog({ tipo: 'acao_usuario', categoria: 'divisao', acao: rec.pago ? 'fatura-paga' : 'fatura-nao-paga', ator: 'Usuário', detalhes: { cartao: card?.nome || cardId, mesCompetencia: mesComp, dataPagamento: rec.dataPagamento } });
  saveAll();
  renderDivisao();
}

// Cards de fatura do Casal do mês corrente, com seletor de forma de pagamento.
function renderFaturasDivisao(sharedExp) {
  const el = document.getElementById('faturas-divisao');
  const monthLbl = document.getElementById('faturas-divisao-month');
  if (monthLbl) monthLbl.textContent = '— ' + formatMonth(currentMonth);
  if (!el) return;
  const p1 = appConfig.p1Name, p2 = appConfig.p2Name;
  const { faturas } = _monthCouplePaid(sharedExp, currentMonth);
  if (!faturas.length) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">💳</div>Nenhuma fatura do Casal neste mês.<br><span style="font-size:11px">Só cartões de crédito com dono "Casal" geram fatura para dividir.</span></div>';
    return;
  }
  el.innerHTML = faturas.map(f => {
    const cor  = f.card?.cor || '#7A3F5E';
    const half = f.total / 2;
    const dg   = f.valorGabriel - half; // saldo de p1 (>0 = a receber de p2)
    let debtLine;
    if (Math.abs(dg) < 0.01) debtLine = `<span style="color:var(--success)">✅ Ninguém deve nada</span>`;
    else if (dg > 0)         debtLine = `<strong>${escapeHtml(p2)}</strong> deve <strong>${fmt(Math.abs(dg))}</strong> para <strong>${escapeHtml(p1)}</strong>`;
    else                     debtLine = `<strong>${escapeHtml(p1)}</strong> deve <strong>${fmt(Math.abs(dg))}</strong> para <strong>${escapeHtml(p2)}</strong>`;
    const btn = (val, label) => `<button class="btn ${f.formaPagamento===val?'btn-primary':'btn-secondary'}" style="font-size:11px;padding:5px 10px" onclick="setFaturaForma('${f.cardId}','${currentMonth}','${val}')">${escapeHtml(label)}</button>`;
    const custom = f.formaPagamento === 'personalizado' ? `
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:end">
        <div><label style="font-size:10px;color:var(--muted)">${escapeHtml(p1)} pagou</label><input type="text" id="fat-vg-${escapeHtml(f.cardId)}" inputmode="numeric" value="${f.valorGabriel.toFixed(2).replace('.',',')}" style="width:110px;font-size:12px" /></div>
        <div><label style="font-size:10px;color:var(--muted)">${escapeHtml(p2)} pagou</label><input type="text" id="fat-va-${escapeHtml(f.cardId)}" inputmode="numeric" value="${f.valorAnna.toFixed(2).replace('.',',')}" style="width:110px;font-size:12px" /></div>
        <button class="btn btn-secondary" style="font-size:11px;padding:6px 10px" onclick="saveFaturaPersonalizado('${f.cardId}','${currentMonth}')">Salvar</button>
        <span style="font-size:10px;color:var(--muted)">Total: ${fmt(f.total)}</span>
      </div>` : '';
    return `<div style="border:1px solid var(--border);border-left:3px solid ${escapeHtml(cor)};border-radius:9px;padding:12px 14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
        <div style="font-size:14px;font-weight:700">💳 ${escapeHtml(f.card?.nome||'Cartão')}${f.card?.final?` <span style="font-family:monospace;color:var(--muted);font-size:11px">•${escapeHtml(f.card.final)}</span>`:''}</div>
        <div style="font-size:16px;font-weight:700;font-variant-numeric:tabular-nums">${fmt(f.total)}</div>
      </div>
      <div style="font-size:10px;color:var(--muted);margin:2px 0 9px">${f.count} lançamento${f.count!==1?'s':''} · ${formatMonth(currentMonth)}</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        ${btn('dividido','Dividido 50/50')}
        ${btn('p1', p1 + ' pagou tudo')}
        ${btn('p2', p2 + ' pagou tudo')}
        ${btn('personalizado','Personalizado')}
      </div>
      ${custom}
      <div style="font-size:12px;margin-top:9px;padding-top:9px;border-top:1px solid var(--border)">${debtLine}</div>
      <div style="margin-top:8px;display:flex;align-items:center;gap:8px">
        <button class="btn ${f.pago?'btn-success':'btn-secondary'}" style="font-size:11px;padding:5px 10px" onclick="toggleFaturaPago('${f.cardId}','${currentMonth}')">${f.pago?'✅ Paga':'Marcar como paga'}</button>
        ${f.pago&&f.dataPagamento?`<span style="font-size:10px;color:var(--muted)">em ${escapeHtml(f.dataPagamento)}</span>`:''}
      </div>
    </div>`;
  }).join('');
}

function renderDivisao() {
  renderAnnualBalance();
  const me = contextMonthExpenses();
  const pColors = getPersonColors();
  const p1 = appConfig.p1Name, p2 = appConfig.p2Name;
  const coupleName = appConfig.coupleName;

  // Only shared ("Casal") expenses enter the couple's division. Personal expenses
  // (pessoa === p1/p2, from personal cards or manual personal entries) are 100% the
  // owner's responsibility and never create a debt between the two.
  const shared      = me.filter(e => e.pessoa === coupleName);
  const sharedTotal = shared.reduce((s,e)=>s+e.valor,0);
  // Novo modelo: quem adiantou vem das faturas do mês (forma de pagamento por
  // fatura) + gastos manuais do Casal (divididos por padrão).
  const { p1Paid, p2Paid } = _monthCouplePaid(shared, currentMonth);

  renderFaturasDivisao(shared);

  const balEl = document.getElementById('balance-summary');
  if (!shared.length) {
    balEl.innerHTML = '<div class="empty"><div class="empty-icon">⚖️</div>Nenhum gasto do Casal neste mês.<br><span style="font-size:11px">Gastos pessoais não entram na divisão.</span></div>';
  } else {
    const diff = (Math.round(p1Paid * 100) - Math.round(p2Paid * 100)) / 100; // centavos → sem ruído de float
    let html = `<div style="display:flex;flex-direction:column;gap:8px">
      <div style="font-size:12px;color:var(--muted)">Gastos do Casal: <strong>${fmt(sharedTotal)}</strong> · Divisão igualitária: <strong>${fmt(sharedTotal/2)}</strong> cada</div>`;
    if (Math.abs(diff) > 0.005) {
      const debtor   = diff>0 ? escapeHtml(p2) : escapeHtml(p1);
      const creditor = diff>0 ? escapeHtml(p1) : escapeHtml(p2);
      html += `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:9px;padding:10px 14px">
        <div style="font-size:13px;font-weight:600;color:var(--success)">💸 Acerto de contas</div>
        <div style="font-size:13px;margin-top:4px"><strong>${debtor}</strong> deve <strong class="split-balance-pos">${fmt(Math.abs(diff)/2)}</strong> para <strong>${creditor}</strong></div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">${escapeHtml(p1)} adiantou ${fmt(p1Paid)} · ${escapeHtml(p2)} adiantou ${fmt(p2Paid)}</div>
      </div>`;
    } else {
      html += `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:9px;padding:10px 14px;font-size:13px;color:var(--success)">✅ Contas do Casal equilibradas! Nenhum acerto necessário.</div>`;
    }
    balEl.innerHTML = html + '</div>';
  }

  // No novo modelo a atribuição é por fatura (não por gasto), então aqui só
  // mostramos quanto cada um adiantou e onde o Casal gastou (por categoria).
  const catBreakAll = {};
  shared.forEach(e => catBreakAll[e.categoria] = (catBreakAll[e.categoria]||0) + e.valor);
  const catLinesAll = Object.entries(catBreakAll).sort((a,b)=>b[1]-a[1])
    .map(([c,v]) => `<span class="badge">${escapeHtml(c)}: ${fmt(v)}</span>`).join(' ');
  document.getElementById('person-breakdown').innerHTML = shared.length ? `
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <div style="flex:1;min-width:140px;background:var(--faint);border:1px solid var(--border);border-radius:8px;padding:9px 13px">
        <div style="font-size:11px;color:var(--muted)">${escapeHtml(p1)} adiantou</div>
        <div style="font-size:17px;font-weight:700;color:${pColors[p1]||'#888'};font-variant-numeric:tabular-nums">${fmt(p1Paid)}</div>
      </div>
      <div style="flex:1;min-width:140px;background:var(--faint);border:1px solid var(--border);border-radius:8px;padding:9px 13px">
        <div style="font-size:11px;color:var(--muted)">${escapeHtml(p2)} adiantou</div>
        <div style="font-size:17px;font-weight:700;color:${pColors[p2]||'#888'};font-variant-numeric:tabular-nums">${fmt(p2Paid)}</div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:5px">Onde o Casal gastou:</div>
    <div style="display:flex;gap:4px;flex-wrap:wrap">${catLinesAll}</div>
  ` : '<div class="empty">Nenhum gasto do Casal.</div>';

  const instEl = document.getElementById('installments-list');
  const instExp = expenses.filter(e=>e.installment&&e.installment.current<e.installment.total);
  if (!instExp.length) { instEl.innerHTML='<div class="empty"><div class="empty-icon">📅</div>Nenhuma parcela em aberto.</div>'; return; }
  const grouped={};
  instExp.forEach(e => { const key=e.descricao; if(!grouped[key]) grouped[key]={e,paid:0,total:e.installment.total}; grouped[key].paid=Math.max(grouped[key].paid,e.installment.current); });
  instEl.innerHTML = Object.values(grouped).map(({e,paid,total}) => {
    const pct=(paid/total)*100;
    return `<div class="installment-item">
      <div style="font-size:18px">${e.icone}</div>
      <div class="installment-progress">
        <div class="installment-name">${escapeHtml(e.descricao)}</div>
        <div class="budget-bar-wrap"><div class="budget-bar-fill" style="width:${pct}%;background:#3266ad"></div></div>
        <div class="installment-meta">${paid}/${total} parcelas · ${fmt(e.installment.parcela)}/mês · Total: ${fmt(e.installment.totalVal)}</div>
      </div>
      <div style="font-size:12px;color:var(--muted)">${total-paid}x restantes</div>
    </div>`;
  }).join('');
}

// ─── REPORTS ──────────────────────────────────────────────────────
function initReportDates() {
  const [yr,mo] = currentMonth.split('-');
  document.getElementById('rep-from').value = `${yr}-${mo}-01`;
  const lastDay = new Date(parseInt(yr),parseInt(mo),0).getDate();
  document.getElementById('rep-to').value   = `${yr}-${mo}-${String(lastDay).padStart(2,'0')}`;
  document.getElementById('rep-person').innerHTML =
    '<option value="">Todos</option>' +
    [appConfig.p1Name, appConfig.p2Name, appConfig.coupleName, appConfig.companyName]
      .map(p=>`<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
}

function generateReport() {
  const from=document.getElementById('rep-from').value, to=document.getElementById('rep-to').value;
  const person=document.getElementById('rep-person').value;
  const filtered = expenses.filter(e=>{
    const iso=e.data&&e.data.includes('/')?parseDateStr(e.data):(e.data||'');
    return (!from||iso>=from)&&(!to||iso<=to)&&(!person||e.pessoa===person)&&(!e.contexto||e.contexto===currentContext);
  }).sort((a,b)=>{
    const ia=a.data&&a.data.includes('/')?parseDateStr(a.data):a.data;
    const ib=b.data&&b.data.includes('/')?parseDateStr(b.data):b.data;
    return ia>ib?-1:1;
  });
  const total=filtered.reduce((a,e)=>a+e.valor,0);
  const catMap={};
  filtered.forEach(e=>catMap[e.categoria]=(catMap[e.categoria]||0)+e.valor);
  const catSummary=Object.entries(catMap).sort((a,b)=>b[1]-a[1]);
  document.getElementById('report-output').innerHTML = `
    <div class="card"><div class="card-title">Resumo por categoria</div>
      <table class="report-table"><thead><tr><th>Categoria</th><th>Total</th><th>%</th></tr></thead>
        <tbody>${catSummary.map(([c,v])=>`<tr><td>${escapeHtml(c)}</td><td>${fmt(v)}</td><td>${total?((v/total)*100).toFixed(1):'0'}%</td></tr>`).join('')}</tbody>
      </table>
      <div style="margin-top:10px;font-size:13px;font-weight:600;text-align:right">Total: ${fmt(total)} · ${filtered.length} lançamentos</div>
    </div>
    <div class="card"><div class="card-title">Lançamentos detalhados</div>
      <table class="report-table"><thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Pessoa</th><th>Método</th><th>Valor</th></tr></thead>
        <tbody>${filtered.map(e=>`<tr><td>${escapeHtml(e.data)}</td><td>${escapeHtml(e.descricao)}</td><td>${e.icone} ${escapeHtml(e.categoria)}</td><td>${escapeHtml(e.pessoa)}</td><td>${escapeHtml(e.metodo||'—')}</td><td>${fmt(e.valor)}</td></tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function exportCSV() {
  const from=document.getElementById('rep-from').value, to=document.getElementById('rep-to').value;
  const person=document.getElementById('rep-person').value;
  const filtered=expenses.filter(e=>{
    const iso=e.data&&e.data.includes('/')?parseDateStr(e.data):(e.data||'');
    return (!from||iso>=from)&&(!to||iso<=to)&&(!person||e.pessoa===person);
  });
  const header='Data,Descrição,Categoria,Pessoa,Método,Valor,Contexto\n';
  const rows=filtered.map(e=>`${e.data},"${e.descricao.replace(/"/g,'""')}",${e.categoria},${e.pessoa},${e.metodo||''},${e.valor.toFixed(2)},${e.contexto||'pessoal'}`).join('\n');
  const blob=new Blob(['﻿'+header+rows],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`gastos_${from}_${to}.csv`; a.click();
}

// ─── CATEGORY MANAGER ────────────────────────────────────────────
function getAllCategories() {
  const all = DEFAULT_CATEGORIES.map(c=>({...c,palavras:[...c.palavras]}));
  for (const custom of customCats) {
    const ex = all.find(c=>c.id===custom.id);
    if (ex) {
      if (custom.removed) ex.palavras=ex.palavras.filter(w=>!custom.removed.includes(w));
      ex.palavras=[...new Set([...ex.palavras,...(custom.palavras||[])])];
    } else { all.push({...custom}); }
  }
  return all;
}

function renderCatGrid() {
  document.getElementById('cat-grid').innerHTML = getAllCategories().map(cat => `
    <div class="cat-card" id="catcard-${escapeHtml(cat.id)}">
      <div class="cat-card-header">
        <span class="cat-icon-big">${cat.icone}</span>
        <span class="cat-name">${escapeHtml(cat.nome)}</span>
        <span class="cat-color-dot" style="background:${escapeHtml(cat.cor)}"></span>
        ${!DEFAULT_CATEGORIES.find(d=>d.id===cat.id)?`<button class="btn-icon" onclick="deleteCategory('${escapeHtml(cat.id)}')" title="Excluir">🗑</button>`:''}
      </div>
      <div class="cat-word-list" id="words-${escapeHtml(cat.id)}">${cat.palavras.map(w=>wordChipHTML(cat.id,w)).join('')}</div>
      <div class="add-word-row">
        <input type="text" id="neword-${escapeHtml(cat.id)}" placeholder="Nova palavra..." onkeydown="if(event.key==='Enter')addWord('${escapeHtml(cat.id)}')" />
        <button class="btn btn-primary" style="padding:4px 9px;font-size:11px" onclick="addWord('${escapeHtml(cat.id)}')">+</button>
      </div>
    </div>`).join('');
}

function wordChipHTML(catId, word) {
  const safeId=catId.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  const safeWord=word.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  return `<span class="word-chip">${escapeHtml(word)}<button onclick="removeWord('${safeId}','${safeWord}')">✕</button></span>`;
}

function addWord(catId) {
  const input=document.getElementById(`neword-${catId}`);
  const word=input.value.trim().toLowerCase();
  if (!word) return;
  let custom=customCats.find(c=>c.id===catId);
  if (!custom) { const base=getAllCategories().find(c=>c.id===catId); custom={id:catId,nome:base?.nome||catId,icone:base?.icone||'📦',cor:base?.cor||'#888',palavras:[],removed:[]}; customCats.push(custom); }
  if (!custom.palavras.includes(word)) { custom.palavras.push(word); saveAll(); }
  input.value='';
  const listEl=document.getElementById(`words-${catId}`);
  if (listEl) listEl.innerHTML=getAllCategories().find(c=>c.id===catId)?.palavras.map(w=>wordChipHTML(catId,w)).join('')||'';
  notify(`"${word}" adicionado!`,'ok');
}

function removeWord(catId, word) {
  const isDefault=DEFAULT_CATEGORIES.find(c=>c.id===catId)?.palavras.includes(word);
  let custom=customCats.find(c=>c.id===catId);
  if (!custom) { const base=getAllCategories().find(c=>c.id===catId); custom={id:catId,nome:base.nome,icone:base.icone,cor:base.cor,palavras:[],removed:[]}; customCats.push(custom); }
  if (!custom.removed) custom.removed=[];
  if (isDefault) custom.removed.push(word);
  custom.palavras=custom.palavras.filter(w=>w!==word);
  saveAll();
  const listEl=document.getElementById(`words-${catId}`);
  if (listEl) listEl.innerHTML=getAllCategories().find(c=>c.id===catId)?.palavras.map(w=>wordChipHTML(catId,w)).join('')||'';
  notify(`"${word}" removido.`,'info');
}

function renderMerchantMap() {
  const container = document.getElementById('merchant-map-list');
  if (!container) return;
  const entries = Object.entries(merchantMap);
  if (!entries.length) {
    container.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0">Nenhum mapeamento aprendido ainda. Corrija descrições ou categorias de lançamentos de fatura para começar.</div>';
    return;
  }
  container.innerHTML = entries.map(([key, m]) => {
    const statusIcon = m.autoAplicar ? '🟢' : '🟡';
    const catColor   = getAllCategories().find(c => c.id === m.categoriaIdCorrigida)?.cor || '#888';
    const catIcon    = getAllCategories().find(c => c.id === m.categoriaIdCorrigida)?.icone || '📦';
    const remaining  = m.autoAplicar ? '' : ` · auto em ${3 - m.vezesCorrigido}×`;
    return `
    <div class="expense-item" style="padding:8px 12px;align-items:flex-start">
      <div style="font-size:18px;flex-shrink:0;margin-top:1px">${statusIcon}</div>
      <div class="expense-main">
        <div class="expense-desc" style="font-size:11px;gap:4px;flex-wrap:wrap">
          <span style="color:var(--muted);font-family:monospace;font-size:10px">${escapeHtml(key)}</span>
          <span style="color:var(--muted)">→</span>
          <strong>${escapeHtml(m.nomeCorrigido)}</strong>
          <span class="badge" style="background:${escapeHtml(catColor)}22;color:${escapeHtml(catColor)}">${catIcon} ${escapeHtml(m.categoriaCorrigida)}</span>
        </div>
        <div class="expense-meta" style="gap:8px">
          <span>${m.vezesCorrigido}× corrigido${remaining}</span>
          <span>${m.autoAplicar ? '<span style="color:var(--success);font-weight:600">✓ auto-aplicar ativo</span>' : 'aguardando 3 correções'}</span>
          ${m.ultimaCorrecao ? `<span>${m.ultimaCorrecao}</span>` : ''}
        </div>
      </div>
      <div class="expense-actions" style="gap:4px;flex-shrink:0">
        <button class="btn-icon" data-key="${escapeHtml(key)}" onclick="toggleMerchantAutoApply(this.dataset.key)" title="${m.autoAplicar ? 'Desativar' : 'Ativar'} auto-aplicar">${m.autoAplicar ? '⏸' : '▶'}</button>
        <button class="btn-icon" data-key="${escapeHtml(key)}" onclick="deleteMerchantMapping(this.dataset.key)" title="Excluir mapeamento">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function populateMerchantCatSelect() {
  const sel = document.getElementById('merchant-form-cat');
  if (!sel) return;
  sel.innerHTML = getAllCategories().map(c =>
    `<option value="${escapeHtml(c.id)}">${c.icone} ${escapeHtml(c.nome)}</option>`
  ).join('');
}

function saveMerchantMapping() {
  const key    = document.getElementById('merchant-form-key').value.trim();
  const nome   = document.getElementById('merchant-form-nome').value.trim();
  const catId  = document.getElementById('merchant-form-cat').value;
  if (!key || !nome) { notify('Preencha a descrição original e o nome corrigido.', 'err'); return; }
  const catObj = getAllCategories().find(c => c.id === catId);
  merchantMap[key] = {
    nomeCorrigido: nome,
    categoriaCorrigida: catObj?.nome || catId,
    categoriaIdCorrigida: catId,
    vezesCorrigido: merchantMap[key]?.vezesCorrigido || 1,
    autoAplicar: true,
    ultimaCorrecao: today(),
  };
  saveAll();
  document.getElementById('merchant-form-key').value  = '';
  document.getElementById('merchant-form-nome').value = '';
  renderMerchantMap();
  notify('Mapeamento salvo!', 'ok');
}

function toggleMerchantAutoApply(key) {
  if (!merchantMap[key]) return;
  merchantMap[key].autoAplicar = !merchantMap[key].autoAplicar;
  saveAll();
  renderMerchantMap();
}

function deleteMerchantMapping(key) {
  if (!merchantMap[key]) return;
  delete merchantMap[key];
  saveAll();
  renderMerchantMap();
  notify('Mapeamento removido.', 'info');
}

function createCategory() {
  const name=document.getElementById('new-cat-name').value.trim();
  const icon=document.getElementById('new-cat-icon').value.trim()||'📦';
  const words=document.getElementById('new-cat-words').value.split(',').map(w=>w.trim().toLowerCase()).filter(Boolean);
  if (!name) { notify('Digite um nome.','err'); return; }
  const id=name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,'_');
  if (customCats.find(c=>c.id===id)||DEFAULT_CATEGORIES.find(c=>c.id===id)) { notify('Já existe.','err'); return; }
  customCats.push({id,nome:name,icone:icon,cor:selectedColor,palavras:words});
  saveAll(); renderCatGrid();
  document.getElementById('new-cat-name').value='';
  document.getElementById('new-cat-icon').value='📦';
  document.getElementById('new-cat-icon-btn').textContent='📦';
  document.getElementById('new-cat-words').value='';
  notify(`"${name}" criada!`,'ok');
}

function deleteCategory(id) {
  if (!confirm('Excluir esta categoria?')) return;
  customCats=customCats.filter(c=>c.id!==id);
  saveAll(); renderCatGrid();
  notify('Categoria excluída.','info');
}

// ─── TELEGRAM BOT ─────────────────────────────────────────────────
// Mascara um token do Telegram (formato "123456789:AA...") mostrando só o head
// antes do ":" (o bot id, não-secreto) + ":***".
function maskToken(tok) {
  if (!tok || typeof tok !== 'string') return tok;
  const i = tok.indexOf(':');
  const head = i > 0 ? tok.slice(0, i) : tok.slice(0, 6);
  return head + ':***';
}

// Remove de uma string qualquer ocorrência dos segredos atuais (token do bot na
// URL/path e secret do Sheets), substituindo por versão mascarada. Usado em todo
// log para garantir que nada exponha a credencial completa.
function scrubSecrets(str) {
  if (typeof str !== 'string') return str;
  let out = str;
  const tok = appConfig && appConfig.tgToken;
  if (tok && tok.length >= 4) out = out.split(tok).join(maskToken(tok));
  const sec = appConfig && appConfig.sheetsSecret;
  if (sec && sec.length >= 4) out = out.split(sec).join('***');
  return out;
}

function addLog(msg, type='') {
  const el=document.getElementById('log-box');
  const div=document.createElement('div');
  div.className='log-line '+type;
  div.textContent=`[${new Date().toLocaleTimeString('pt-BR')}] ${scrubSecrets(msg)}`;
  el.appendChild(div); el.scrollTop=el.scrollHeight;
}

// ─── BOT INTERNO — DESATIVADO (deprecated) ────────────────────────
// O bot roda 24/7 no Render (servidor externo). O bot interno do Electron foi
// removido da UI (não há mais botão "Iniciar bot" nem badge de status) porque
// ligá-lo causa erro 409 (conflito de polling com o bot do Render). Estas
// funções ficam como no-op defensivo — caso algo antigo as chame, não fazem
// nada e não referenciam elementos de UI que não existem mais.
// `pollTelegram()` é mantida abaixo apenas como referência do formato do bot;
// não é mais agendada por ninguém.
function toggleBot() { startBot(); }

/** @deprecated Bot interno desativado — o bot externo (Render) é o único ativo. */
function startBot() {
  console.warn('[bot] startBot() ignorado — bot interno desativado (o bot roda no Render).');
  notify('O bot roda 24/7 no Render. Não há bot interno no app.', 'info');
}

/** @deprecated Bot interno desativado. */
function stopBot() {
  if (botInterval) clearInterval(botInterval);
  botRunning = false;
  appConfig.botWasRunning = false;
}

async function pollTelegram(cfg) {
  try {
    const resp=await fetch(`https://api.telegram.org/bot${cfg.tgToken}/getUpdates?offset=${lastUpdateId+1}&timeout=0`);
    const data=await resp.json();
    if (!data.ok) { addLog('Erro: '+(data.description||'?'),'err'); return; }
    if (!Array.isArray(data.result) || !data.result.length) return;
    for (const update of data.result) {
      if (!update || typeof update !== 'object') continue;
      lastUpdateId=update.update_id;
      const msg=update.message||update.channel_post;
      if (!msg || !msg.chat) continue;
      const normalize=id=>String(id).replace(/^-100/,'').replace(/^-/,'');
      if (normalize(msg.chat.id)!==normalize(cfg.tgGroup)) { addLog(`Chat ${msg.chat.id} ignorado`,''); continue; }
      // Limita o tamanho do texto antes de classificar (evita processar payload gigante).
      const text=sanitizeText(msg.text||msg.caption||'', VALIDATION.msgMax);
      const from=sanitizeText(msg.from?.first_name, VALIDATION.nameMax)||'Alguém';
      if (!text) continue;
      addLog(`📩 ${from}: "${text.slice(0,70)}"`, 'info');
      const r=classifyInput(text);
      if (!r||r.valor===null) { addLog('↩ Sem valor detectado.',''); continue; }
      addExpenseObj({...r, pessoa:from, mensagem:text, metodo:'Telegram'});
      addLog(`✓ ${r.descricao} — ${fmt(r.valor)} [${r.categoria}]`,'ok');
      try {
        await fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`,{
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({chat_id:msg.chat.id, text:`${r.icone} *${r.descricao}*\n💸 ${fmt(r.valor)}\n📂 ${r.categoria}\n👤 ${from}`, parse_mode:'Markdown'})
        });
      } catch {}
    }
  } catch(e) { addLog('Erro de rede: '+e.message,'err'); }
}

async function testBot() {
  const cfg=getConfig();
  addLog('=== TESTE ===','info');
  try {
    const r=await fetch(`https://api.telegram.org/bot${cfg.tgToken}/getMe`);
    const d=await r.json();
    if (d.ok) addLog(`✓ Bot: @${d.result.username}`,'ok');
    else addLog(`✗ Token inválido: ${d.description}`,'err');
  } catch(e) { addLog('✗ Erro de rede: '+e.message,'err'); }
  try {
    const r=await fetch(`https://api.telegram.org/bot${cfg.tgToken}/getUpdates?limit=5`);
    const d=await r.json();
    if (d.ok&&d.result.length) {
      const ids=[...new Set(d.result.map(u=>{const m=u.message||u.channel_post; return m?`chat_id=${m.chat.id} (${m.chat.title||m.chat.first_name||'privado'})`:null}).filter(Boolean))];
      addLog('Chats: '+ids.join(' | '),'info');
      addLog('ID configurado: '+cfg.tgGroup,'info');
    } else addLog('Nenhuma msg recente. Envie algo no grupo.','');
  } catch(e) { addLog('Erro: '+e.message,'err'); }
  const tr=classifyInput('farmácia 50 reais');
  addLog(`✓ Classificador OK — ${tr.descricao} ${fmt(tr.valor)}`,'ok');
  addLog('=== FIM ===','info');
}

// ─── GOOGLE SHEETS SYNC ──────────────────────────────────────────
// Puxa os gastos salvos pelo bot no Sheets e mescla com os locais
let _syncInterval = null;

async function syncFromSheets() {
  const url = appConfig.appsScriptUrl;
  if (!url) return;
  try {
    const sheetsSecret = document.getElementById('cfg-sheets-secret')?.value?.trim() || appConfig.sheetsSecret || '';
    const resp = await fetch(`${url}?acao=listar&secret=${encodeURIComponent(sheetsSecret)}`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data.ok || !Array.isArray(data.gastos)) return;

    const existingIds = new Set(expenses.map(e => String(e.id)));
    let added = 0, dropped = 0;
    const allCatsSync   = getAllCategories();
    const catByIdSync   = Object.fromEntries(allCatsSync.map(c => [c.id,                 c]));
    const catByNameSync = Object.fromEntries(allCatsSync.map(c => [c.nome.toLowerCase(), c]));

    for (const g of data.gastos) {
      if (!g || typeof g !== 'object' || g.id == null) { dropped++; continue; }
      if (existingIds.has(String(g.id))) continue; // ja existe, pula
      if (deletedExpenseIds.has(String(g.id))) continue; // foi apagado, nao recriar
      // Validacao de tipos - descarta registros com valor invalido/fora da faixa.
      const valorSan = sanitizeMoney(g.valor);
      if (valorSan === null) { dropped++; continue; }
      const categoriaSan = sanitizeText(g.categoria, VALIDATION.catMax) || 'Outros';
      const catIdNorm  = categoriaSan.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,'_');
      const catDefSync = catByIdSync[catIdNorm] || catByNameSync[categoriaSan.toLowerCase()];
      // Data invalida/absurda -> cai para hoje (nao descarta o gasto por causa da data).
      const dataSan = sanitizeDateBR(g.data) || new Date().toLocaleDateString('pt-BR');
      // Converte formato do Sheets para formato do app
      const gSync = {
        id:          g.id,
        descricao:   sanitizeText(g.descricao, VALIDATION.descMax),
        valor:       valorSan,
        categoria:   categoriaSan,
        categoriaId: catIdNorm,
        icone:       catDefSync?.icone || '📦',
        cor:         catDefSync?.cor   || '#5F5E5A',
        pessoa:      sanitizeText(g.pessoa, VALIDATION.nameMax),
        mensagem:    sanitizeText(g.mensagem, VALIDATION.msgMax),
        confianca:   parseInt(g.confianca) || 0,
        metodo:      sanitizeText(g.metodo, VALIDATION.nameMax) || 'Telegram',
        data:        dataSan,
        ts:          parseInt(g.id) || Date.now(),
        splitOf:     null, splitPct: null, installment: null,
      };
      expenses.unshift(gSync);
      auditLog({ tipo: 'acao_usuario', categoria: 'lancamento', acao: 'criar', ator: 'Bot', detalhes: { origem: 'telegram' }, depois: _expLogSnapshot({ ...gSync, origem: 'telegram' }) });
      added++;
    }
    if (dropped > 0) {
      console.warn(`[sync] ${dropped} registro(s) descartado(s) por falha de validacao.`);
      auditLog({ tipo: 'erro', categoria: 'sync', acao: 'registros-descartados', ator: 'Sistema', detalhes: { quantidade: dropped } });
    }

    if (added > 0) {
      appConfig.sheetsLastSync = Date.now();
      saveConfigToStorage();
      await saveAll();
      updateMetrics(); renderRecent(); renderList(); renderCharts(); renderBudgetAlerts();
      notify(`${added} gasto(s) sincronizado(s) do bot! 📊`, 'ok');
    }

    // Update sync indicator
    const el = document.getElementById('sheets-sync-status');
    if (el) el.textContent = `Última sync: ${new Date().toLocaleTimeString('pt-BR')}`;

  } catch(e) {
    console.error('Erro ao sincronizar do Sheets:', scrubSecrets(e.message));
    auditLog({ tipo: 'erro', categoria: 'sync', acao: 'erro', ator: 'Sistema', detalhes: { mensagem: scrubSecrets(String(e && e.message || e)) } });
  }
}

function startSheetsSync() {
  if (_syncInterval) clearInterval(_syncInterval);
  if (!appConfig.appsScriptUrl) return;
  syncFromSheets(); // sync imediato ao iniciar
  _syncInterval = setInterval(syncFromSheets, 30000); // a cada 30s
}

// Placeholder — será substituído pela secret real do usuário
const SECRET_TOKEN_PLACEHOLDER = '';


// ─── INVOICE IMPORTER (C6 Bank XLS) ──────────────────────────────

const BANK_CAT_MAP = {
  'supermercados / mercearia / padarias / lojas de conveniencia': 'mercado',
  'restaurante / lanchonete / bar':                              'alimentacao',
  'assistencia medica e odontologica':                           'saude',
  'relacionados a automotivo':                                   'transporte',
  'educacional':                                                 'educacao',
  'especialidade varejo':                                        'outros',
  'associacao':                                                  'outros',
  'empresa servicos':                                            'outros',
};

function _normBankCat(s) {
  return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
}

function mapBankCategory(bankCat, desc) {
  const mapped = BANK_CAT_MAP[_normBankCat(bankCat)];
  if (mapped) return getAllCategories().find(c => c.id === mapped) || getAllCategories().find(c => c.id === 'outros');
  // fallback: use our classifier on the description
  const r = classifyInput(desc || '');
  if (r) {
    const cat = getAllCategories().find(c => c.nome === r.categoria);
    if (cat) return cat;
  }
  return getAllCategories().find(c => c.id === 'outros');
}

function _parseValorBR(val) {
  if (typeof val === 'number') return val;
  const s = String(val || '').replace(/[R$\s]/g, '').trim();
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) return parseFloat(s.replace(/\./g,'').replace(',','.'));
  if (s.includes(',')) return parseFloat(s.replace(',','.'));
  return parseFloat(s) || 0;
}

function _formatDateBR(val) {
  if (val instanceof Date) {
    const d = String(val.getDate()).padStart(2,'0');
    const m = String(val.getMonth()+1).padStart(2,'0');
    return `${d}/${m}/${val.getFullYear()}`;
  }
  // Excel date serial without cellDates conversion (e.g. 46158 → 2026-06-05)
  if (typeof val === 'number' && val > 1000) {
    const dt = new Date(Math.round((val - 25569) * 86400000));
    const d  = String(dt.getUTCDate()).padStart(2,'0');
    const m  = String(dt.getUTCMonth()+1).padStart(2,'0');
    return `${d}/${m}/${dt.getUTCFullYear()}`;
  }
  const s = String(val||'').trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;           // DD/MM/YYYY ✓
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;           // YYYY-MM-DD → DD/MM/YYYY
  return s;
}

function openInvoiceImport() {
  document.getElementById('invoice-file-input').value = '';
  document.getElementById('invoice-file-input').click();
}

// ─── MERCHANT MAP ────────────────────────────────────────────────
// Returns the mapping entry for a given bank description, checking exact
// keys first then wildcard prefix keys ending with '*'.
function _merchantLookup(desc) {
  if (!desc) return null;
  if (merchantMap[desc]) return merchantMap[desc];
  for (const key of Object.keys(merchantMap)) {
    if (key.endsWith('*') && desc.startsWith(key.slice(0, -1))) return merchantMap[key];
  }
  return null;
}

// Upserts a correction into merchantMap. Enables auto-apply once vezesCorrigido >= 3.
function _merchantLearn(origKey, newDesc, newCatId, newCatNome) {
  const entry = merchantMap[origKey] || { vezesCorrigido: 0, autoAplicar: false };
  entry.nomeCorrigido       = newDesc;
  entry.categoriaCorrigida  = newCatNome;
  entry.categoriaIdCorrigida = newCatId;
  entry.vezesCorrigido++;
  entry.ultimaCorrecao = today();
  if (entry.vezesCorrigido >= 3) entry.autoAplicar = true;
  merchantMap[origKey] = entry;
  saveAll();
}

// Buffer da fatura selecionada, guardado para reprocessar com senha sem
// obrigar o usuário a reselecionar o arquivo. Limpo após sucesso/cancelamento.
let _pendingInvoiceBuffer = null;

function handleInvoiceFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (typeof XLSX === 'undefined') {
    notify('Biblioteca SheetJS não carregada. Verifique a conexão.', 'err');
    return;
  }
  const reader = new FileReader();
  reader.onload  = e => { _pendingInvoiceBuffer = e.target.result; _readInvoiceBuffer(e.target.result, ''); };
  reader.onerror = () => notify('Não foi possível ler o arquivo selecionado.', 'err');
  reader.readAsArrayBuffer(file);
}

// Lê o workbook do buffer (senha opcional) e processa as transações. A leitura
// do XLSX fica isolada para distinguir erro de senha/formato dos demais.
function _readInvoiceBuffer(buffer, password) {
  let wb;
  try {
    const opts = { type: 'array', cellDates: true };
    if (password) opts.password = password;
    wb = XLSX.read(new Uint8Array(buffer), opts);
  } catch (err) {
    _handleInvoiceReadError(err, !!password);
    return;
  }

  try {
    const ws   = wb.Sheets[wb.SheetNames[0]];
    // raw:true preserves native types (Dates, numbers); defval:'' fills empty cells
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, raw:true, defval:'' });

    if (!Array.isArray(rows) || rows.length < 3 || !Array.isArray(rows[1])) {
      notify('Arquivo sem transações ou formato inválido.','err'); return;
    }

    // Row 1 contains column headers
    const header = rows[1].map(h => String(h).trim());
    const COL = {
      data:        header.indexOf('Data de compra'),
      catBanco:    header.indexOf('Categoria'),
      desc:        header.indexOf('Descrição'),
      parcela:     header.indexOf('Parcela'),
      valorBR:     header.indexOf('Valor (em R$)'),
      finalCartao: header.indexOf('Final do Cartão'),
    };

    if (COL.desc < 0 || COL.valorBR < 0) {
      notify('Formato de arquivo inesperado — colunas "Descrição" e "Valor (em R$)" não encontradas. Verifique se é a fatura C6 Bank (.xls/.xlsx).','err');
      return;
    }

    const transactions = [];
    let invalidRows = 0;
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row) || !row.some(c => c !== '')) continue;
      // Valor: valida faixa (0..valorMax); descarta zeros, créditos e absurdos.
      const valorBR = sanitizeMoney(_parseValorBR(row[COL.valorBR]));
      if (valorBR === null || valorBR <= 0) { invalidRows++; continue; }
      const desc    = sanitizeText(row[COL.desc], VALIDATION.descMax) || '(sem descrição)';
      // Data: usa a do arquivo se válida, senão hoje.
      const dataBR  = sanitizeDateBR(_formatDateBR(row[COL.data])) || new Date().toLocaleDateString('pt-BR');
      const catBanco= sanitizeText(row[COL.catBanco], VALIDATION.catMax);
      const parcela = sanitizeText(row[COL.parcela], 20);
      const finalCartao = COL.finalCartao >= 0
        ? String(row[COL.finalCartao] || '').trim().replace(/\D/g, '').slice(-4)
        : null;
      const cat         = mapBankCategory(catBanco, desc);
      transactions.push({ desc, dataBR, catBanco, parcela, valorBR, cat, finalCartao });
    }

    if (invalidRows > 0) console.warn(`[fatura] ${invalidRows} linha(s) ignorada(s) por valor inválido/fora da faixa.`);
    if (!transactions.length) { notify('Nenhuma transação válida encontrada no arquivo.','err'); return; }

    // Sucesso: fecha o modal de senha (se aberto) e libera o buffer.
    _pendingInvoiceBuffer = null;
    _closeInvoicePassModal();
    _renderInvoicePreview(transactions);
  } catch(err) {
    console.error('[fatura] Falha ao processar o arquivo:', err && err.message);
    auditLog({ tipo: 'erro', categoria: 'fatura', acao: 'importar-erro', ator: 'Sistema', detalhes: { mensagem: String(err && err.message || err) } });
    notify('Não foi possível interpretar a fatura. Verifique se é uma fatura C6 Bank válida (.xls/.xlsx).', 'err');
  }
}

// Trata erros de XLSX.read com mensagens específicas por tipo de falha.
// triedPassword = true quando a leitura já foi tentada com uma senha informada.
function _handleInvoiceReadError(err, triedPassword) {
  const raw = (err && err.message) ? err.message : String(err || '');
  const msg = raw.toLowerCase();
  const isPassword = msg.includes('password') || msg.includes('encrypt');

  if (isPassword) {
    // SheetJS lança "File is password-protected" (sem senha) ou erro de senha
    // incorreta na descriptografia (com senha).
    _openInvoicePassModal(triedPassword
      ? 'Senha incorreta. Verifique a senha da fatura e tente novamente.'
      : 'Esta fatura está protegida por senha. Exporte a fatura sem senha no site/app do C6, ou tente novamente informando a senha.');
    return;
  }

  console.error('[fatura] Falha ao ler o arquivo:', raw);
  // Mensagem informativa por tipo de falha de leitura.
  let detail;
  if (msg.includes('unsupported') || msg.includes('unrecognized') || msg.includes('cannot find') || msg.includes('format'))
    detail = 'Formato de arquivo não suportado. Exporte a fatura como .xls ou .xlsx no site/app do C6.';
  else if (msg.includes('corrupt') || msg.includes('bad') || msg.includes('zip') || msg.includes('cfb') || msg.includes('end of'))
    detail = 'Arquivo corrompido ou incompleto. Baixe a fatura novamente no site/app do C6 e tente de novo.';
  else
    detail = 'Não foi possível ler o arquivo. Verifique se é uma fatura C6 Bank válida (.xls/.xlsx).';
  notify(detail, 'err');
}

// ─── MODAL DE SENHA DA FATURA ────────────────────────────────────
function _openInvoicePassModal(hintMsg) {
  const hint = document.getElementById('invoice-pass-hint');
  const msg  = document.getElementById('invoice-pass-msg');
  if (hint) hint.textContent = hintMsg || '';
  if (msg)  msg.textContent  = '';
  const modal = document.getElementById('invoice-pass-modal');
  if (modal) modal.classList.add('open');
  setTimeout(() => document.getElementById('invoice-pass-input')?.focus(), 50);
}

function _closeInvoicePassModal() {
  document.getElementById('invoice-pass-modal')?.classList.remove('open');
  const input = document.getElementById('invoice-pass-input');
  if (input) input.value = '';
}

function _retryInvoiceWithPassword() {
  const password = document.getElementById('invoice-pass-input')?.value || '';
  if (!password) {
    const msg = document.getElementById('invoice-pass-msg');
    if (msg) msg.textContent = 'Informe a senha da fatura para continuar.';
    return;
  }
  if (!_pendingInvoiceBuffer) {
    notify('Selecione a fatura novamente para informar a senha.', 'warn');
    _closeInvoicePassModal();
    return;
  }
  _readInvoiceBuffer(_pendingInvoiceBuffer, password);
}

function _renderInvoicePreview(transactions) {
  const allCats = getAllCategories();
  populateInvoiceCardSelect();

  // Map card final digits → card object for auto-detection
  const finalToCard = {};
  cards.forEach(c => { if (c.final) finalToCard[c.final] = c; });

  // Compute per-row card from finalCartao column
  const txCardIds = transactions.map(t =>
    t.finalCartao ? (finalToCard[t.finalCartao]?.id || null) : null
  );
  const uniqueCardIds   = [...new Set(txCardIds.filter(Boolean))];

  // Apply merchant map: auto-correct or flag suggestion on each transaction
  transactions.forEach(t => {
    t.origDesc = t.desc; // always preserve raw bank description
    const mapping = _merchantLookup(t.desc);
    if (!mapping) return;
    if (mapping.autoAplicar) {
      const correctedCat = allCats.find(c => c.id === mapping.categoriaIdCorrigida);
      t.desc = mapping.nomeCorrigido;
      if (correctedCat) t.cat = correctedCat;
      t.autoApplied = true;
    } else {
      t.suggested = mapping;
    }
  });
  const hasPerRowCards  = uniqueCardIds.length > 1;
  const singleDetected  = !hasPerRowCards && uniqueCardIds.length === 1;
  const allDetected     = txCardIds.length > 0 && txCardIds.every(Boolean);

  // Auto-select top selector when all rows come from the same detected card
  const invoiceCardSel = document.getElementById('invoice-card-select');
  if (singleDetected && invoiceCardSel) invoiceCardSel.value = uniqueCardIds[0];

  // The top selector is only a fallback for rows whose card wasn't auto-detected.
  // When every row was detected by the "Final do Cartão" column, hide it entirely.
  const selWrap  = document.getElementById('invoice-card-select-wrap');
  const allDetEl = document.getElementById('invoice-card-alldetected');
  if (selWrap)  selWrap.style.display  = allDetected ? 'none' : 'block';
  if (allDetEl) allDetEl.style.display = allDetected ? 'block' : 'none';

  const total = transactions.reduce((a,t) => a + t.valorBR, 0);
  document.getElementById('invoice-summary').innerHTML =
    `<strong>${transactions.length}</strong> transações encontradas · Total: <strong>${fmt(total)}</strong>`;

  // Update table header — add/remove Cartão column
  const headTr = document.querySelector('#invoice-preview-table thead tr');
  if (headTr) {
    const existing = headTr.querySelector('.inv-card-th');
    if (existing) existing.remove();
    if (hasPerRowCards) {
      const th = document.createElement('th');
      th.className = 'inv-card-th';
      th.textContent = 'Cartão';
      // Insert before the last <th> (Valor)
      headTr.insertBefore(th, headTr.lastElementChild);
    }
  }

  document.getElementById('invoice-rows').innerHTML = transactions.map((t, idx) => {
    const selOptions = allCats.map(c =>
      `<option value="${escapeHtml(c.id)}" ${c.id === t.cat.id ? 'selected' : ''}>${c.icone} ${escapeHtml(c.nome)}</option>`
    ).join('');
    const parcelaBadge = t.parcela && t.parcela !== '1/1'
      ? `<span class="badge" style="background:#fff7ed;color:#c2410c">${escapeHtml(t.parcela)}</span>` : '—';
    const rowCardId = txCardIds[idx];
    const rowCard   = rowCardId ? cards.find(c => c.id === rowCardId) : null;
    const cardAttr  = rowCardId ? ` data-card-id="${escapeHtml(rowCardId)}"` : '';
    const cardTd    = hasPerRowCards
      ? `<td style="font-size:11px;white-space:nowrap">${rowCard
          ? `<span style="color:${escapeHtml(rowCard.cor||'#888')};font-weight:600">${escapeHtml(rowCard.nome)}${rowCard.final ? ' •'+escapeHtml(rowCard.final) : ''}</span>
             <div style="font-size:10px;color:var(--muted)">${escapeHtml(rowCard.dono)}</div>`
          : `<span style="color:var(--muted)">—</span>`}</td>`
      : '';
    const autoBadge = t.autoApplied
      ? `<span style="display:inline-block;margin-left:5px;font-size:9px;padding:1px 5px;background:#dbeafe;color:#1d4ed8;border-radius:3px;font-weight:600">🤖 auto</span>` : '';
    const origLine = (t.autoApplied && t.origDesc !== t.desc)
      ? `<div style="font-size:10px;color:var(--muted);margin-top:1px">orig: ${escapeHtml(t.origDesc)}</div>`
      : (t.catBanco ? `<div style="font-size:10px;color:var(--muted);margin-top:1px">${escapeHtml(t.catBanco)}</div>` : '');
    const suggestChip = t.suggested
      ? `<div class="merchant-suggest" style="margin-top:3px;display:flex;align-items:center;gap:5px;background:#fefce8;border:1px solid #fde047;border-radius:4px;padding:2px 6px;font-size:10px">
           <span style="color:#854d0e">💡 ${escapeHtml(t.suggested.nomeCorrigido)} (${t.suggested.vezesCorrigido}×)</span>
           <button type="button" class="btn-suggest" data-desc="${escapeHtml(t.suggested.nomeCorrigido)}" data-cat="${escapeHtml(t.suggested.categoriaIdCorrigida)}" onclick="_applySuggestion(this)" style="font-size:9px;padding:1px 6px;border:1px solid #fbbf24;border-radius:3px;background:#fff;cursor:pointer;color:#92400e;font-weight:600">aceitar</button>
         </div>` : '';
    return `<tr data-idx="${idx}" data-desc="${escapeHtml(t.desc)}" data-orig-desc="${escapeHtml(t.origDesc)}" data-valor="${t.valorBR}" data-data="${escapeHtml(t.dataBR)}"${cardAttr}>
      <td style="text-align:center"><input type="checkbox" class="inv-chk" checked onchange="_updateInvoiceSummary()" /></td>
      <td style="white-space:nowrap;font-size:11px">${escapeHtml(t.dataBR)}</td>
      <td>
        <div class="inv-desc-main" style="font-size:12px;font-weight:500;line-height:1.3">${escapeHtml(t.desc)}${autoBadge}</div>
        ${origLine}${suggestChip}
      </td>
      <td style="font-size:11px;text-align:center">${parcelaBadge}</td>
      <td>
        <select class="inv-cat" style="font-size:11px;padding:3px 6px;width:100%" onchange="_updateInvoiceSummary()">
          ${selOptions}
        </select>
      </td>
      ${cardTd}
      <td style="text-align:right;font-weight:600;color:var(--danger);white-space:nowrap;font-size:12px">${fmt(t.valorBR)}</td>
    </tr>`;
  }).join('');

  document.getElementById('inv-check-all').checked = true;
  _updateInvoiceSummary();
  document.getElementById('invoice-modal').classList.add('open');
}

// Applies a merchant map suggestion when the user clicks "aceitar" in the preview table.
function _applySuggestion(btn) {
  const suggestDesc  = btn.dataset.desc;
  const suggestCatId = btn.dataset.cat;
  const row = btn.closest('tr[data-idx]');
  if (!row) return;
  row.dataset.desc = suggestDesc;
  const descEl = row.querySelector('.inv-desc-main');
  if (descEl) {
    descEl.textContent = suggestDesc;
    descEl.insertAdjacentHTML('beforeend',
      `<span style="display:inline-block;margin-left:5px;font-size:9px;padding:1px 5px;background:#dbeafe;color:#1d4ed8;border-radius:3px;font-weight:600">🤖 aceito</span>`);
  }
  const catSel = row.querySelector('.inv-cat');
  if (catSel) catSel.value = suggestCatId;
  btn.closest('.merchant-suggest')?.remove();
}

function _updateInvoiceSummary() {
  let count = 0, total = 0;
  document.querySelectorAll('#invoice-rows tr').forEach(row => {
    if (row.querySelector('.inv-chk')?.checked) {
      count++;
      total += parseFloat(row.dataset.valor) || 0;
    }
  });
  const el = document.getElementById('invoice-import-summary');
  if (el) el.textContent = `${count} selecionado(s) · ${fmt(total)}`;
}

function toggleAllInvoiceRows(checked) {
  document.querySelectorAll('#invoice-rows .inv-chk').forEach(chk => { chk.checked = checked; });
  _updateInvoiceSummary();
}

// Removes fatura entries with invalid dates AND duplicate valid fatura entries.
// Keeps the first (array-order) occurrence of each desc|valor|data combination.
function _deduplicateFaturaInPlace() {
  const seen = new Set();
  expenses = expenses.filter(e => {
    if (e.origem !== 'fatura') return true;
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(e.data || '')) return false;
    // Split entries share a _faturaKey — differentiate by person so both halves survive
    const key = e._faturaKey
      ? `${e._faturaKey}|${e.pessoa}`
      : `${e.descricao}|${Number(e.valor).toFixed(2)}|${e.data}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Public: called by the UI button to clean up accumulated duplicates without importing.
function limparDuplicatasFatura() {
  const before = expenses.filter(e => e.origem === 'fatura').length;
  _deduplicateFaturaInPlace();
  const after  = expenses.filter(e => e.origem === 'fatura').length;
  const removed = before - after;
  if (!removed) { notify('Nenhuma duplicata de fatura encontrada.', 'info'); return; }
  saveAll(); updateMetrics(); renderRecent(); renderList(); renderBudgetAlerts();
  notify(`${removed} entrada${removed > 1 ? 's duplicadas removidas' : ' duplicada removida'} da fatura.`, 'ok');
}

function confirmInvoiceImport() {
  const invoiceCardSel       = document.getElementById('invoice-card-select');
  const defaultInvoiceCardId = invoiceCardSel?.value || null;

  const rows = document.querySelectorAll('#invoice-rows tr[data-idx]');
  let count = 0, skipped = 0, _impTotal = 0;
  const _impCards      = new Set();
  const newMonthTally  = {};
  const fileMonthTally = {};

  // Remove ghost/duplicate fatura entries
  _deduplicateFaturaInPlace();

  // Build dedup set: for split entries use _faturaKey (original full-valor key)
  const existingKeys = new Set(
    expenses
      .filter(e => e.origem === 'fatura')
      .flatMap(e => {
        if (e._faturaKey) {
          const keys = [e._faturaKey];
          // Also cover the corrected-description variant (entries edited after import)
          if (e.descricao && e.descricaoOriginal && e.descricaoOriginal !== e.descricao) {
            keys.push(`${e.descricao}|${Number(e.valor).toFixed(2)}|${e.data}`);
          }
          return keys;
        }
        const base = `${e.descricao}|${Number(e.valor).toFixed(2)}|${e.data}`;
        const keys = [base];
        // Also check by original description for older entries that were manually corrected
        if (e.descricaoOriginal && e.descricaoOriginal !== e.descricao) {
          keys.push(`${e.descricaoOriginal}|${Number(e.valor).toFixed(2)}|${e.data}`);
        }
        if (e.splitOf) {
          keys.push(`${e.descricao}|${Number(e.splitOf).toFixed(2)}|${e.data}`);
          if (e.descricaoOriginal && e.descricaoOriginal !== e.descricao) {
            keys.push(`${e.descricaoOriginal}|${Number(e.splitOf).toFixed(2)}|${e.data}`);
          }
        }
        return keys;
      })
  );

  rows.forEach(row => {
    if (!row.querySelector('.inv-chk')?.checked) return;
    const catId = row.querySelector('.inv-cat').value;
    const cat   = getAllCategories().find(c => c.id === catId) || getAllCategories().find(c => c.id === 'outros');

    const raw      = row.dataset.data || '';
    const dataBR   = /^\d{2}\/\d{2}\/\d{4}$/.test(raw) ? raw : new Date().toLocaleDateString('pt-BR');
    const valor    = parseFloat(row.dataset.valor) || 0;
    const desc     = row.dataset.desc;
    const origDesc = row.dataset.origDesc || desc; // raw bank description (pre-correction)
    const key      = `${origDesc}|${valor.toFixed(2)}|${dataBR}`;

    // Per-row card takes priority over top selector
    const rowCardId = row.dataset.cardId || defaultInvoiceCardId || null;
    const rowCard   = rowCardId ? cards.find(c => c.id === rowCardId) : null;
    const mesComp   = calcularMesCompetencia(dataBR, 'Crédito', rowCardId);
    fileMonthTally[mesComp] = (fileMonthTally[mesComp] || 0) + 1;

    if (existingKeys.has(key)) { skipped++; return; }
    existingKeys.add(key);

    const [day, mon, yr] = dataBR.split('/');
    const dateObj = new Date(parseInt(yr), parseInt(mon)-1, parseInt(day));
    newMonthTally[mesComp] = (newMonthTally[mesComp] || 0) + 1;

    const baseEntry = {
      descricao: desc, descricaoOriginal: origDesc,
      categoria: cat.nome, categoriaId: cat.id,
      icone: cat.icone, cor: cat.cor,
      mensagem: '', confianca: 100,
      data: dataBR, ts: isNaN(dateObj) ? Date.now() : dateObj.getTime(),
      metodo: 'Crédito', cardId: rowCardId,
      mesCompetencia: mesComp, origem: 'fatura',
      installment: null, fixedId: null, contexto: currentContext,
    };

    // Always a single entry — the person is the card owner (card.dono), never the
    // printed titular. Couple-owned cards (dono === coupleName) stay as "Casal"; a
    // Divisão reparte cada fatura do Casal 50/50 conforme quem pagou aquele mês
    // (faturaPagamentos), não uma propriedade fixa do cartão.
    const personForFatura = rowCard?.dono || currentPerson;
    expenses.unshift({ ...baseEntry, id: Date.now() + Math.random() + count,
      valor, pessoa: personForFatura, splitOf: null, splitPct: null, _faturaKey: key });
    count++;
    _impTotal += valor;
    if (rowCard) _impCards.add(rowCard.nome + (rowCard.final ? ' •' + rowCard.final : ''));
  });

  if (!count && !skipped) { notify('Nenhuma transação selecionada.', 'warn'); return; }

  // Switch to the month with the most transactions in the FILE (new or existing),
  // so the user always lands on the right month even when everything is deduplicated.
  const topMonth = Object.entries(fileMonthTally).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topMonth && topMonth !== currentMonth) {
    currentMonth = topMonth;
    const sel = document.getElementById('month-sel');
    if (sel) sel.value = topMonth;
  }

  if (!count) {
    updateMetrics(); renderRecent(); renderList(); renderBudgetAlerts();
    notify(`Todas as ${skipped} transações já estavam importadas. Exibindo ${formatMonth(topMonth || currentMonth)}.`, 'info');
    closeInvoiceModal();
    return;
  }

  auditLog({ tipo: 'acao_usuario', categoria: 'fatura', acao: 'importar', ator: 'Usuário', detalhes: { itens: count, duplicadosIgnorados: skipped, total: Math.round(_impTotal * 100) / 100, cartoes: [..._impCards], meses: newMonthTally } });
  saveAll(); updateMetrics(); renderRecent(); renderList(); renderBudgetAlerts();

  const breakdown = Object.entries(newMonthTally)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([m, n]) => `${formatMonth(m)}: ${n}`)
    .join(' · ');
  const dupMsg = skipped ? ` (${skipped} já existia${skipped > 1 ? 'm' : ''})` : '';
  notify(`${count} importados${dupMsg} — ${breakdown}`, 'ok');
  closeInvoiceModal();
}

function closeInvoiceModal() {
  document.getElementById('invoice-modal').classList.remove('open');
}

// ─── CARDS ────────────────────────────────────────────────────────
function renderCardsList() {
  const container = document.getElementById('cards-list');
  if (!container) return;
  if (!cards.length) {
    container.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0">Nenhum cartão cadastrado.</div>';
    return;
  }
  container.innerHTML = cards.map(c => `
    <div class="expense-item" style="padding:10px 12px">
      <div class="expense-icon" style="background:${escapeHtml(c.cor||'#344B62')}22">💳</div>
      <div class="expense-main">
        <div class="expense-desc">${escapeHtml(c.nome)}${c.final ? `<span style="font-family:monospace;color:var(--muted);font-size:11px;margin-left:5px">•${escapeHtml(c.final)}</span>` : ''}</div>
        <div class="expense-meta">
          <span class="badge" style="background:${escapeHtml(c.cor||'#344B62')}22;color:${escapeHtml(c.cor||'#344B62')}">${escapeHtml(c.tipo||'Crédito')}</span>
          <span class="badge-person" style="background:${personColor(c.dono)}22;color:${personColor(c.dono)}">${escapeHtml(c.dono||'—')}</span>
          ${c.titular ? `<span style="color:var(--muted)">${escapeHtml(c.titular)}</span>` : ''}
          ${c.tipo !== 'Débito' && c.diaFechamento ? `<span>Fecha ${c.diaFechamento} · Vence ${c.diaVencimento}</span>` : ''}
        </div>
      </div>
      <div class="expense-actions">
        <button class="btn-icon" onclick="openCardForm('${escapeHtml(c.id)}')" title="Editar">✏️</button>
        <button class="btn-icon" onclick="deleteCard('${escapeHtml(c.id)}')" title="Remover">🗑</button>
      </div>
    </div>`).join('');
}

let _editingCardId      = null;
let _selectedCardColor  = CARD_COLORS[0];

function openCardForm(cardId) {
  _editingCardId = cardId || null;
  const card = cardId ? cards.find(c => c.id === cardId) : null;
  document.getElementById('card-form-nome').value       = card?.nome    || '';
  document.getElementById('card-form-final').value      = card?.final   || '';
  document.getElementById('card-form-titular').value    = card?.titular || '';
  document.getElementById('card-form-divisao').value    = card?.divisao ?? 100;
  document.getElementById('card-form-tipo').value       = card?.tipo    || 'Crédito';
  document.getElementById('card-form-fechamento').value = card?.diaFechamento || '';
  document.getElementById('card-form-vencimento').value = card?.diaVencimento || '';
  document.getElementById('card-form-aviso').value      = card?.avisoAntecedencia ?? 5;

  const persons = [appConfig.p1Name, appConfig.p2Name, appConfig.coupleName];
  const donoSel = document.getElementById('card-form-dono');
  donoSel.innerHTML = persons.map(p =>
    `<option value="${escapeHtml(p)}" ${p === (card?.dono||appConfig.p1Name) ? 'selected' : ''}>${escapeHtml(p)}</option>`
  ).join('');

  const currentColor = card?.cor || CARD_COLORS[0];
  _selectedCardColor = currentColor;
  document.querySelectorAll('#card-color-picker .card-color-opt').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.color === currentColor);
  });

  onCardTipoChange();
  document.getElementById('card-form-title').textContent = cardId ? 'Editar cartão' : 'Novo cartão';
  document.getElementById('card-form-wrap').style.display = 'block';
}

function closeCardForm() {
  document.getElementById('card-form-wrap').style.display = 'none';
  _editingCardId = null;
}

function selectCardColor(el) {
  document.querySelectorAll('#card-color-picker .card-color-opt').forEach(x => x.classList.remove('selected'));
  el.classList.add('selected');
  _selectedCardColor = el.dataset.color;
}

function onCardTipoChange() {
  const tipo  = document.getElementById('card-form-tipo')?.value;
  const wrap  = document.getElementById('card-form-dates-wrap');
  const extra = document.getElementById('card-form-credit-extra');
  if (wrap)  wrap.style.display  = tipo === 'Débito' ? 'none' : 'grid';
  if (extra) extra.style.display = tipo === 'Débito' ? 'none' : 'block';
}

function saveCard() {
  const nome = document.getElementById('card-form-nome').value.trim();
  if (!nome) { notify('Digite o nome do cartão.', 'err'); return; }
  const tipo       = document.getElementById('card-form-tipo').value;
  const dono       = document.getElementById('card-form-dono').value;
  const final_     = (document.getElementById('card-form-final')?.value || '').replace(/\D/g, '').slice(-4);
  const titular    = document.getElementById('card-form-titular')?.value.trim() || '';
  const divisao    = Math.min(100, Math.max(1, parseInt(document.getElementById('card-form-divisao')?.value) || 100));
  const fechamento = parseInt(document.getElementById('card-form-fechamento').value) || 0;
  const vencimento = parseInt(document.getElementById('card-form-vencimento').value) || 0;
  const aviso      = Math.max(1, parseInt(document.getElementById('card-form-aviso').value) || 5);
  if (tipo !== 'Débito' && (!fechamento || !vencimento)) {
    notify('Configure dia de fechamento e vencimento para cartão de crédito.', 'err'); return;
  }
  const cor = _selectedCardColor || CARD_COLORS[0];
  const _cardLog = c => ({ nome: c.nome, final: c.final, tipo: c.tipo, dono: c.dono, diaFechamento: c.diaFechamento, diaVencimento: c.diaVencimento });
  if (_editingCardId) {
    const c = cards.find(x => x.id === _editingCardId);
    if (c) {
      const antesCard = _cardLog(c);
      const oldFech = c.diaFechamento, oldVenc = c.diaVencimento;
      c.nome = nome; c.final = final_; c.titular = titular; c.divisao = divisao;
      c.tipo = tipo; c.dono = dono; delete c.pagador;
      c.diaFechamento = fechamento; c.diaVencimento = vencimento; c.cor = cor;
      c.avisoAntecedencia = aviso; c.ativo = c.ativo ?? true;
      auditLog({ tipo: 'acao_usuario', categoria: 'cartao', acao: 'editar', ator: 'Usuário', detalhes: { id: c.id }, antes: antesCard, depois: _cardLog(c) });
      saveAll();
      if (oldFech !== fechamento || oldVenc !== vencimento) recalcularCompetencias(_editingCardId);
    }
  } else {
    const novoCard = { id: 'card_' + Date.now(), nome, final: final_, titular, divisao, tipo, dono, diaFechamento: fechamento, diaVencimento: vencimento, cor, avisoAntecedencia: aviso, ativo: true };
    cards.push(novoCard);
    auditLog({ tipo: 'acao_usuario', categoria: 'cartao', acao: 'criar', ator: 'Usuário', detalhes: { id: novoCard.id }, depois: _cardLog(novoCard) });
    saveAll();
  }
  closeCardForm();
  renderCardsList();
  notify('Cartão salvo!', 'ok');
}

function deleteCard(id) {
  if (!confirm('Remover este cartão? Os lançamentos associados não serão afetados.')) return;
  const alvo = cards.find(c => c.id === id);
  cards = cards.filter(c => c.id !== id);
  auditLog({ tipo: 'acao_usuario', categoria: 'cartao', acao: 'excluir', ator: 'Usuário', detalhes: { id }, antes: alvo ? { nome: alvo.nome, final: alvo.final, tipo: alvo.tipo, dono: alvo.dono } : null });
  saveAll();
  renderCardsList();
  notify('Cartão removido.', 'info');
}

function populateAddCardSelect(method) {
  const wrap = document.getElementById('add-card-wrap');
  if (!wrap) return;
  const matching = cards.filter(c => c.tipo === method);
  if (method !== 'Crédito' && method !== 'Débito') { wrap.style.display = 'none'; return; }
  if (!matching.length) { wrap.style.display = 'none'; return; }
  document.getElementById('add-card').innerHTML =
    `<option value="">— Selecionar cartão —</option>` +
    matching.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.nome)}${c.final ? ' •'+escapeHtml(c.final) : ''} (${escapeHtml(c.dono)})</option>`).join('');
  wrap.style.display = 'block';
}

function populateEditCardSelect(method, currentCardId) {
  const wrap = document.getElementById('edit-card-wrap');
  if (!wrap) return;
  const matching = cards.filter(c => c.tipo === method);
  if (method !== 'Crédito' && method !== 'Débito') { wrap.style.display = 'none'; return; }
  if (!matching.length) { wrap.style.display = 'none'; return; }
  document.getElementById('edit-card').innerHTML =
    `<option value="">— Nenhum —</option>` +
    matching.map(c => `<option value="${escapeHtml(c.id)}" ${c.id === currentCardId ? 'selected' : ''}>${escapeHtml(c.nome)}${c.final ? ' •'+escapeHtml(c.final) : ''} (${escapeHtml(c.dono)})</option>`).join('');
  wrap.style.display = 'block';
}

function populateInvoiceCardSelect() {
  const sel = document.getElementById('invoice-card-select');
  if (!sel) return;
  const creditCards = cards.filter(c => c.tipo === 'Crédito');
  sel.innerHTML =
    `<option value="">— Nenhum cartão —</option>` +
    creditCards.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.nome)}${c.final ? ' •'+escapeHtml(c.final) : ''} (${escapeHtml(c.dono)})</option>`).join('');
  if (creditCards.length === 1) sel.value = creditCards[0].id;
}

function onAddMethodChange() {
  const method = document.getElementById('add-method')?.value;
  if (method !== undefined) populateAddCardSelect(method);
}

function onEditMethodChange() {
  const method = document.getElementById('edit-method')?.value;
  if (method !== undefined) populateEditCardSelect(method, null);
  _updateEditPagoPor();
}

// ─── FATURAS ──────────────────────────────────────────────────────
/*
 * Returns the current open billing cycle for a credit card, based on today's date.
 * The cycle runs from (closeDay+1 of last month) up to (closeDay of this or next month).
 *
 * Example — closeDay=30, vencimento=10, today=05/Jul:
 *   d (5) <= closeDay (30) → cycle ends this month
 *   cycleStart = 01/Jul (day after June 30)
 *   cycleEnd   = 30/Jul
 *   dueDate    = 10/Ago (dueDay 10 <= closeDay 30 → vencimento mês seguinte)
 */
function getCardCurrentCycle(card) {
  const closeDay = card.diaFechamento;
  const dueDay   = card.diaVencimento;
  const now = new Date();
  const d = now.getDate(), m = now.getMonth(), y = now.getFullYear();
  const msPerDay = 86400000;
  const norm  = dt => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const lastOf = (yr, mo) => new Date(yr, mo + 1, 0).getDate(); // mo is 0-based

  let closeDate, startDate;

  if (d <= closeDay) {
    // This month's closing hasn't happened yet
    closeDate = norm(new Date(y, m, Math.min(closeDay, lastOf(y, m))));
    // Previous closing date
    const pm = m === 0 ? 11 : m - 1;
    const py = m === 0 ? y - 1 : y;
    const prevClose = Math.min(closeDay, lastOf(py, pm));
    const nextDay   = prevClose + 1;
    startDate = nextDay > lastOf(py, pm)
      ? norm(new Date(y, m, 1))
      : norm(new Date(py, pm, nextDay));
  } else {
    // This month's closing has already passed
    const thisClose = Math.min(closeDay, lastOf(y, m));
    const nextDay   = thisClose + 1;
    startDate = nextDay > lastOf(y, m)
      ? norm(new Date(y, m + 1, 1))
      : norm(new Date(y, m, nextDay));
    // Next month closing
    const nm = m === 11 ? 0 : m + 1;
    const ny = m === 11 ? y + 1 : y;
    closeDate = norm(new Date(ny, nm, Math.min(closeDay, lastOf(ny, nm))));
  }

  // Invoice due date
  let dm = closeDate.getMonth() + 1; // 1-based
  let dy = closeDate.getFullYear();
  if (dueDay <= closeDay) { dm++; if (dm > 12) { dm = 1; dy++; } }
  const dueDate = norm(new Date(dy, dm - 1, Math.min(dueDay, new Date(dy, dm, 0).getDate())));

  const todayNorm   = norm(now);
  const daysTotal   = Math.round((closeDate - startDate) / msPerDay) + 1;
  const daysPast    = Math.max(0, Math.round((todayNorm - startDate) / msPerDay) + 1);
  const daysToClose = Math.max(0, Math.round((closeDate - todayNorm) / msPerDay));
  const pctElapsed  = Math.min(100, Math.max(0, Math.round(daysPast / daysTotal * 100)));

  const toISO  = dt => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const fmtShort = dt => `${String(dt.getDate()).padStart(2,'0')}/${months[dt.getMonth()]}`;
  const fmtDay   = dt => `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}`;

  return {
    cycleStart:   toISO(startDate),
    cycleEnd:     toISO(closeDate),
    cycleStartBR: fmtShort(startDate),
    cycleEndBR:   fmtShort(closeDate),
    dueDateBR:    fmtDay(dueDate),
    daysToClose, daysPast, daysTotal, pctElapsed,
  };
}

function renderFaturas() {
  const el = document.getElementById('faturas-abertas');
  if (!el) return;

  const creditCards = cards.filter(c => c.tipo === 'Crédito');

  if (!creditCards.length) {
    el.innerHTML = `<div class="card">
      <div class="card-title">💳 Faturas em aberto</div>
      <div class="empty" style="padding:16px 0">
        <div class="empty-icon">💳</div>
        Nenhum cartão de crédito cadastrado.
        <a href="#" onclick="switchTab('config')" style="color:var(--blue);display:block;margin-top:6px">Adicionar na Config →</a>
      </div>
    </div>`;
    return;
  }

  const sectionsHTML = creditCards.map((card, idx) => {
    const isLast = idx === creditCards.length - 1;
    const cycle = getCardCurrentCycle(card);

    const cycleExpenses = expenses
      .filter(e => {
        if (e.cardId !== card.id) return false;
        if (!e.data) return false;
        const iso = e.data.includes('/') ? parseDateStr(e.data) : e.data;
        return iso >= cycle.cycleStart && iso <= cycle.cycleEnd;
      })
      .sort((a, b) => {
        const ia = a.data.includes('/') ? parseDateStr(a.data) : a.data;
        const ib = b.data.includes('/') ? parseDateStr(b.data) : b.data;
        return ib.localeCompare(ia);
      });

    const total    = cycleExpenses.reduce((s, e) => s + e.valor, 0);
    const cor      = card.cor || '#344B62';
    const cid      = escapeHtml(card.id);
    const pc       = personColor(card.dono);
    const barColor = cycle.pctElapsed < 60 ? 'var(--success)'
                   : cycle.pctElapsed < 85 ? 'var(--warn)'
                   : 'var(--danger)';

    const closeLabel = cycle.daysToClose === 0
      ? `<strong style="color:var(--warn)">Fecha hoje!</strong>`
      : `Fecha em <strong>${cycle.daysToClose}</strong> dia${cycle.daysToClose !== 1 ? 's' : ''}`;

    const txHTML = cycleExpenses.length
      ? cycleExpenses.map(e => `
          <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)">
            <div style="font-size:18px;flex-shrink:0">${e.icone || '📦'}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.descricao)}</div>
              <div style="font-size:10px;color:var(--muted)">${escapeHtml(e.data)} · ${escapeHtml(e.categoria)}</div>
            </div>
            <div style="font-size:12px;font-weight:600;color:var(--danger);white-space:nowrap">${fmt(e.valor)}</div>
          </div>`).join('')
      : `<div style="color:var(--muted);font-size:12px;padding:12px 0;text-align:center">Nenhum lançamento neste ciclo ainda.</div>`;

    return `<div style="padding:14px 0${isLast ? '' : ';border-bottom:1px solid var(--border)'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:4px;height:36px;border-radius:2px;background:${escapeHtml(cor)};flex-shrink:0"></div>
          <div>
            <div style="font-size:13px;font-weight:700">${escapeHtml(card.nome)}</div>
            <span class="badge-person" style="background:${pc}22;color:${pc};font-size:10px">${escapeHtml(card.dono)}</span>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:22px;font-weight:700;color:var(--danger);line-height:1">${fmt(total)}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:2px">${cycleExpenses.length} lançamento${cycleExpenses.length !== 1 ? 's' : ''}</div>
        </div>
      </div>

      <div style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-bottom:4px">
          <span>${cycle.cycleStartBR} → ${cycle.cycleEndBR}</span>
          <span>${cycle.pctElapsed}% do ciclo</span>
        </div>
        <div style="height:5px;background:var(--border);border-radius:3px;overflow:hidden">
          <div style="height:100%;width:${cycle.pctElapsed}%;background:${barColor};border-radius:3px"></div>
        </div>
      </div>

      <div style="font-size:11px;color:var(--muted)">
        ${closeLabel} &nbsp;·&nbsp; Vence dia <strong>${cycle.dueDateBR}</strong>
      </div>

      <div style="margin-top:10px">
        <button onclick="_toggleFaturaDetail('${cid}', ${cycleExpenses.length})"
          id="fatura-toggle-${cid}"
          style="background:none;border:none;font-size:11px;font-weight:600;color:var(--blue);cursor:pointer;padding:0">
          ▸ Ver lançamentos (${cycleExpenses.length})
        </button>
        <div id="fatura-detail-${cid}" style="display:none;margin-top:6px">${txHTML}</div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="card">
    <div class="card-title">💳 Faturas em aberto</div>
    <div>${sectionsHTML}</div>
  </div>`;
}

function _toggleFaturaDetail(cardId, count) {
  const detail = document.getElementById('fatura-detail-' + cardId);
  const btn    = document.getElementById('fatura-toggle-' + cardId);
  if (!detail) return;
  const opening = detail.style.display === 'none';
  detail.style.display = opening ? 'block' : 'none';
  if (btn) btn.textContent = opening ? '▾ Ocultar lançamentos' : `▸ Ver lançamentos (${count})`;
}

/*
 * Returns the most recently CLOSED billing cycle for a card.
 * "Closed" means the closing date has already passed (the invoice amount is fixed).
 * Used to check if the payment due date is approaching.
 *
 * Example — closeDay=30, dueDay=10, today=05/Aug:
 *   d(5) <= closeDay(30) → last closing = Jul 30
 *   cycleStart = Jul 1 · cycleEnd = Jul 30 · dueDate = Aug 10 · daysUntilDue = 5
 */
function getLastClosedCycle(card) {
  const closeDay = card.diaFechamento;
  const dueDay   = card.diaVencimento;
  const now = new Date();
  const d = now.getDate(), m = now.getMonth(), y = now.getFullYear();
  const msPerDay = 86400000;
  const norm   = dt => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const lastOf = (yr, mo) => new Date(yr, mo + 1, 0).getDate();

  // Last closing date (invoice already frozen)
  let lastCloseDate;
  if (d <= closeDay) {
    const pm = m === 0 ? 11 : m - 1;
    const py = m === 0 ? y - 1 : y;
    lastCloseDate = norm(new Date(py, pm, Math.min(closeDay, lastOf(py, pm))));
  } else {
    lastCloseDate = norm(new Date(y, m, Math.min(closeDay, lastOf(y, m))));
  }

  // Cycle start = day after the previous closing
  const lm = lastCloseDate.getMonth(), ly = lastCloseDate.getFullYear();
  const pm2 = lm === 0 ? 11 : lm - 1;
  const py2  = lm === 0 ? ly - 1 : ly;
  const prevClose = Math.min(closeDay, lastOf(py2, pm2));
  let startD = prevClose + 1, startM = pm2, startY = py2;
  if (startD > lastOf(py2, pm2)) { startD = 1; startM = lm; startY = ly; }
  const cycleStart = norm(new Date(startY, startM, startD));

  // Invoice due date
  let dm = lm + 1, dy = ly; // 1-based month of lastCloseDate
  if (dueDay <= closeDay) { dm++; if (dm > 12) { dm = 1; dy++; } }
  const dueDate = norm(new Date(dy, dm - 1, Math.min(dueDay, new Date(dy, dm, 0).getDate())));

  const todayNorm    = norm(now);
  const daysUntilDue = Math.round((dueDate - todayNorm) / msPerDay);

  const toISO = dt => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  const fmtBR = dt => `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}`;

  return {
    cycleStart:   toISO(cycleStart),
    cycleEnd:     toISO(lastCloseDate),
    dueDateBR:    fmtBR(dueDate),
    daysUntilDue,
    alertKey: `${card.id}-${toISO(dueDate).slice(0, 7)}`,
  };
}

function renderInvoiceAlerts() {
  const el = document.getElementById('invoice-alerts');
  if (!el) return;

  const creditCards = cards.filter(c => c.tipo === 'Crédito' && c.diaFechamento && c.diaVencimento);
  const dismissed   = appConfig.dismissedInvoiceAlerts || [];

  const alerts = [];
  for (const card of creditCards) {
    const closed = getLastClosedCycle(card);
    const aviso  = card.avisoAntecedencia ?? 5;
    if (closed.daysUntilDue < 0 || closed.daysUntilDue > aviso) continue;
    if (dismissed.includes(closed.alertKey)) continue;

    const total = expenses
      .filter(e => {
        if (e.cardId !== card.id) return false;
        if (!e.data) return false;
        const iso = e.data.includes('/') ? parseDateStr(e.data) : e.data;
        return iso >= closed.cycleStart && iso <= closed.cycleEnd;
      })
      .reduce((s, e) => s + e.valor, 0);

    alerts.push({ card, closed, total });
  }

  if (!alerts.length) { el.innerHTML = ''; return; }

  el.innerHTML =
    `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">` +
    alerts.map(({ card, closed, total }) => {
      const key    = escapeHtml(closed.alertKey);
      const days   = closed.daysUntilDue;
      const bg     = days === 0 ? '#fef2f2' : days <= 2 ? '#fff7ed' : '#fffbeb';
      const border = days === 0 ? '#fca5a5' : days <= 2 ? '#fed7aa' : '#fcd34d';
      const color  = days === 0 ? '#b91c1c' : days <= 2 ? '#c2410c' : '#92400e';
      const icon   = days === 0 ? '🚨' : '⚠️';
      const dayLabel = days === 0 ? '<strong>HOJE</strong>'
                     : days === 1 ? 'amanhã'
                     : `em <strong>${days} dias</strong>`;
      const pc = personColor(card.dono);
      return `<div style="background:${bg};border:1px solid ${border};border-radius:9px;padding:8px 12px;font-size:12px;color:${color};display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span>${icon} Fatura <strong>${escapeHtml(card.nome)}</strong> vence ${dayLabel} (${escapeHtml(closed.dueDateBR)}) — total: <strong>${fmt(total)}</strong>
          <span class="badge-person" style="background:${pc}22;color:${pc};font-size:10px;margin-left:4px">${escapeHtml(card.dono)}</span>
        </span>
        <button onclick="dismissInvoiceAlert('${key}')"
          style="background:none;border:none;cursor:pointer;font-size:15px;color:${color};opacity:.6;flex-shrink:0;padding:2px 0 0 4px;line-height:1"
          title="Dispensar este alerta">✕</button>
      </div>`;
    }).join('') +
    `</div>`;
}

function dismissInvoiceAlert(alertKey) {
  if (!appConfig.dismissedInvoiceAlerts) appConfig.dismissedInvoiceAlerts = [];
  if (!appConfig.dismissedInvoiceAlerts.includes(alertKey)) {
    appConfig.dismissedInvoiceAlerts.push(alertKey);
    saveConfigToStorage();
  }
  renderInvoiceAlerts();
}

// ─── INIT ─────────────────────────────────────────────────────────
async function init() {
  await loadAll();
  loadConfig();
  // Registra a pasta de dados customizada na allowlist do main (se houver),
  // para snapshots/saves nela continuarem permitidos após reiniciar o app.
  if (isElectron() && appConfig.dataFolderPath) {
    try { await window.electronAPI.registerDataFolder(appConfig.dataFolderPath); } catch {}
  }
  await hydrateSecrets();
  setupCurrencyInputs();
  renderAppVersionInfo();
  // Bridge de auditoria: recebe eventos do main (auto-update) e grava no log JSONL.
  try { window.electronAPI.onAuditLog && window.electronAPI.onAuditLog(auditLog); } catch {}
  appConfig.botWasRunning = false; // bot externo (Render) é o único autorizado
  startSheetsSync(); // start syncing from Google Sheets
  buildMonthSelector();
  _annualYear = currentMonth.split('-')[0];
  _autoGenerateFixed();
  currentPerson = appConfig.p1Name;
  renderPersonPills();
  populateBudgetCatSelect();
  populateFixedCatSelect();
  populateFixedPersonSelect();
  updateMetrics();
  renderInvoiceAlerts();
  renderFaturas();
  renderRecent();
  renderList();
  renderCatFilters();

  // Show data path in config form once resolved
  resolveDataFilePath().then(() => renderCfgForm());

  // Migração: cria cartão principal a partir das datas globais se ainda não há cartões cadastrados.
  if (!cards.length && appConfig.diaFechamento && appConfig.diaVencimento) {
    cards.push({
      id: 'card_principal',
      nome: 'Cartão principal',
      tipo: 'Crédito',
      dono: appConfig.coupleName || appConfig.p1Name,
      diaFechamento: appConfig.diaFechamento,
      diaVencimento: appConfig.diaVencimento,
      divisao: 100, cor: CARD_COLORS[0], ativo: true,
    });
    saveAll();
  }

  // Pré-cadastra 3 cartões C6 padrão em instalação nova (sem datas globais configuradas)
  if (!cards.length) {
    const fechamento = appConfig.diaFechamento || 30;
    const vencimento = appConfig.diaVencimento || 10;
    cards = [
      { id: 'card_c6_5058', nome: 'C6 Carbon Pessoal', final: '5058', titular: 'Gabriel Alberto',
        dono: appConfig.p1Name,     tipo: 'Crédito', diaFechamento: fechamento, diaVencimento: vencimento,
        divisao: 100, cor: '#344B62', avisoAntecedencia: 5, ativo: true },
      { id: 'card_c6_9161', nome: 'C6 Carbon Virtual', final: '9161', titular: 'Gabriel Alberto',
        dono: appConfig.p1Name,     tipo: 'Crédito', diaFechamento: fechamento, diaVencimento: vencimento,
        divisao: 100, cor: '#2E5480', avisoAntecedencia: 5, ativo: true },
      { id: 'card_c6_1256', nome: 'C6 Casal',          final: '1256', titular: 'Anna Carolina',
        dono: appConfig.coupleName, tipo: 'Crédito', diaFechamento: fechamento, diaVencimento: vencimento,
        divisao: 50,  cor: '#7A3F5E', avisoAntecedencia: 5, ativo: true },
    ];
    saveAll();
  }

  // Migração: remove o campo `pagador` legado dos cartões (modelo antigo, errado —
  // o pagador da fatura do Casal varia mês a mês; agora vive em faturaPagamentos).
  let cardsMigrated = false;
  cards.forEach(c => { if ('pagador' in c) { delete c.pagador; cardsMigrated = true; } });
  if (cardsMigrated) saveAll();

  // Migração silenciosa: preenche mesCompetencia ausente em lançamentos de crédito existentes.
  // Se diaFechamento/diaVencimento não estiverem configurados, usa o mês da compra como fallback.
  let migrated = false;
  expenses.forEach(e => {
    if (e.metodo === 'Crédito' && e.data && !e.mesCompetencia) {
      e.mesCompetencia = calcularMesCompetencia(e.data, 'Crédito', e.cardId || null);
      migrated = true;
    }
  });
  if (migrated) saveAll();

  // Migração (uma vez): faturas de cartão do Casal antes eram divididas em duas metades
  // (p1 + p2) no momento da importação. No modelo atual cada gasto do Casal é UMA entry
  // com pessoa = 'Casal' (a aba Divisão é que reparte). Reúne os pares divididos de volta
  // numa entry única, senão eles (a) não entram na Divisão e (b) bloqueiam a reimportação
  // pelo dedup de `_faturaKey`. Só toca entradas claramente auto-divididas (fatura+splitOf).
  if (!appConfig.splitFaturaMerged) {
    const groups = {};
    expenses.forEach(e => {
      if (e.origem === 'fatura' && e._faturaKey && e.splitOf) {
        const card = cards.find(c => c.id === e.cardId);
        if (card && card.dono === appConfig.coupleName) {
          (groups[e._faturaKey] = groups[e._faturaKey] || []).push(e);
        }
      }
    });
    const keys = Object.keys(groups);
    if (keys.length) {
      const mergedIds = new Set();
      keys.forEach(k => {
        const members = groups[k];
        const first   = members[0];
        const card    = cards.find(c => c.id === first.cardId);
        members.forEach(m => mergedIds.add(m.id));
        expenses.push({ ...first,
          id: Date.now() + Math.random(),
          valor: Number(first.splitOf),
          pessoa: appConfig.coupleName,
          splitOf: null, splitPct: null, splitPct2: null });
      });
      expenses = expenses.filter(e => !mergedIds.has(e.id));
    }
    appConfig.splitFaturaMerged = true;
    saveConfigToStorage();
    saveAll();
  }

  // Bot interno desativado — bot externo (Render) está ativo e faz o polling
  addLog('Bot externo ativo (Render). Bot interno desabilitado para evitar conflito 409.', 'info');
}

init();
