const { app, BrowserWindow, Menu, Tray, ipcMain, dialog, nativeImage, session, safeStorage } = require('electron');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');

let win  = null;
let tray = null;
let isQuitting = false;

// ─── AUTO UPDATE (electron-updater + GitHub Releases) ─────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

let manualUpdateCheck = false;

autoUpdater.on('update-available', (info) => {
  console.log(`[updater] Atualização disponível: v${info.version}`);
});

autoUpdater.on('update-not-available', () => {
  if (manualUpdateCheck && win) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Verificar atualizações',
      message: 'Você já está usando a versão mais recente do Finannza.',
    });
  }
  manualUpdateCheck = false;
});

autoUpdater.on('update-downloaded', (info) => {
  manualUpdateCheck = false;
  if (!win) return;
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Atualização disponível',
    message: `Uma nova versão (v${info.version}) foi baixada.`,
    detail: 'Reinicie o app agora para aplicar a atualização, ou deixe para depois — ela será instalada no próximo fechamento.',
    buttons: ['Reiniciar agora', 'Depois'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) {
      isQuitting = true;
      if (tray) { tray.destroy(); tray = null; }
      if (win) win.close();
      autoUpdater.quitAndInstall(true, true);
    }
  });
});

autoUpdater.on('error', (err) => {
  console.error('[updater] Erro ao verificar/baixar atualização:', err == null ? 'desconhecido' : (err.stack || err).toString());
  if (manualUpdateCheck && win) {
    dialog.showMessageBox(win, {
      type: 'error',
      title: 'Verificar atualizações',
      message: 'Não foi possível verificar atualizações.',
      detail: err == null ? 'Erro desconhecido.' : (err.message || err.toString()),
    });
  }
  manualUpdateCheck = false;
});

function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    console.log('[updater] Ignorado — app rodando em modo de desenvolvimento (não empacotado).');
    if (manual && win) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Verificar atualizações',
        message: 'Verificação de atualizações indisponível em modo de desenvolvimento.',
        detail: 'Isso só funciona no aplicativo instalado (.exe), não ao rodar via "npm start".',
      });
    }
    return;
  }
  manualUpdateCheck = manual;
  autoUpdater.checkForUpdatesAndNotify().catch(err => {
    console.error('[updater] Falha ao verificar atualizações:', err);
    if (manual && win) {
      dialog.showMessageBox(win, {
        type: 'error',
        title: 'Verificar atualizações',
        message: 'Não foi possível verificar atualizações.',
        detail: err.message || err.toString(),
      });
    }
    manualUpdateCheck = false;
  });
}

// ─── ALLOWLIST DE CAMINHOS (defesa contra IPC read/write arbitrário) ──
// read-file/write-file/delete-file/list-dir/file-exists só operam em caminhos
// permitidos: a pasta de dados (userData + pasta customizada registrada) e os
// arquivos/pastas escolhidos pelo usuário via diálogo nativo (que o renderer
// não consegue forjar). Bloqueia um XSS teórico de ler/escrever fora disso.
const _allowedRoots = new Set(); // diretórios (recursivo)
const _allowedFiles = new Set(); // arquivos exatos (retornos de diálogo)

function _addAllowedRoot(p) {
  try { if (p) _allowedRoots.add(path.resolve(p)); } catch {}
}
function _isPathAllowed(target) {
  let resolved;
  try { resolved = path.resolve(String(target)); } catch { return false; }
  if (_allowedFiles.has(resolved)) return true;
  for (const root of _allowedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return true;
  }
  return false;
}

// ─── IPC HANDLERS ────────────────────────────────────────────────
ipcMain.handle('read-file', (_event, filePath) => {
  if (!_isPathAllowed(filePath)) { console.warn('[ipc] read-file negado — fora da allowlist'); return null; }
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
});

ipcMain.handle('write-file', (_event, filePath, content) => {
  if (!_isPathAllowed(filePath)) { console.warn('[ipc] write-file negado — fora da allowlist'); return false; }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  } catch (e) { return false; }
});

// Registra a pasta de dados customizada (persistida) como raiz permitida.
// Chamado pelo renderer no init com appConfig.dataFolderPath (se houver).
ipcMain.handle('register-data-folder', (_event, folderPath) => {
  try {
    if (!folderPath) return false;
    const r = path.resolve(String(folderPath));
    if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) return false;
    if (path.dirname(r) === r) return false; // é raiz de drive (ex: C:\) — recusa
    _addAllowedRoot(r);
    return true;
  } catch { return false; }
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled) return null;
  _addAllowedRoot(result.filePaths[0]); // pasta escolhida pelo usuário → permitida
  return result.filePaths[0];
});

ipcMain.handle('get-default-data-path', () => {
  return app.getPath('userData');
});

ipcMain.handle('path-join', (_event, ...parts) => {
  return path.join(...parts);
});

ipcMain.handle('file-exists', (_event, filePath) => {
  if (!_isPathAllowed(filePath)) return false;
  return fs.existsSync(filePath);
});

ipcMain.handle('save-file-dialog', async (_event, options) => {
  const result = await dialog.showSaveDialog(win, options);
  if (result.canceled) return null;
  _allowedFiles.add(path.resolve(result.filePath)); // arquivo escolhido → permitido
  return result.filePath;
});

ipcMain.handle('open-file-dialog', async (_event, options) => {
  const result = await dialog.showOpenDialog(win, { ...options, properties: ['openFile'] });
  if (result.canceled) return null;
  _allowedFiles.add(path.resolve(result.filePaths[0])); // arquivo escolhido → permitido
  return result.filePaths[0];
});

// Lista arquivos de um diretório (para os snapshots automáticos). Retorna
// [{ name, mtime, size }]; diretório inexistente → []. Nunca lança.
ipcMain.handle('list-dir', (_event, dirPath) => {
  if (!_isPathAllowed(dirPath)) return [];
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(d => d.isFile())
      .map(d => {
        let mtime = 0, size = 0;
        try { const st = fs.statSync(path.join(dirPath, d.name)); mtime = st.mtimeMs; size = st.size; } catch {}
        return { name: d.name, mtime, size };
      });
  } catch { return []; }
});

// Apaga um arquivo (usado no prune de snapshots antigos). Retorna bool.
ipcMain.handle('delete-file', (_event, filePath) => {
  if (!_isPathAllowed(filePath)) { console.warn('[ipc] delete-file negado — fora da allowlist'); return false; }
  try { fs.unlinkSync(filePath); return true; } catch { return false; }
});

// ─── SECRETS (safeStorage) ───────────────────────────────────────
// Criptografa/descriptografa segredos (token do bot, secret do Sheets) com a
// chave do SO (DPAPI no Windows). Retorna { available, value }:
//   - available:false → criptografia indisponível na máquina (fallback texto puro no renderer)
//   - value:null      → falha (ex: blob cifrado em outra máquina/usuário não descriptografa aqui)
ipcMain.handle('encrypt-secret', (_event, plain) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return { available: false, value: null };
    if (typeof plain !== 'string' || plain === '') return { available: true, value: '' };
    return { available: true, value: safeStorage.encryptString(plain).toString('base64') };
  } catch { return { available: false, value: null }; }
});

ipcMain.handle('decrypt-secret', (_event, b64) => {
  try {
    if (!safeStorage.isEncryptionAvailable()) return { available: false, value: null };
    if (typeof b64 !== 'string' || b64 === '') return { available: true, value: '' };
    return { available: true, value: safeStorage.decryptString(Buffer.from(b64, 'base64')) };
  } catch { return { available: true, value: null }; }
});

// ─── BACKUP: integridade (SHA-256) + criptografia opcional (AES-256-GCM) ──
// backup-seal: calcula o checksum do conteúdo e, se houver senha, criptografa.
//   password vazia/nula → { encrypted:false, checksum }.
//   com senha → { encrypted:true, checksum, salt, iv, authTag, data(base64) }.
// A chave AES-256 é derivada da senha via scrypt (salt aleatório por backup).
const _sha256 = txt => crypto.createHash('sha256').update(txt, 'utf8').digest('hex');

ipcMain.handle('backup-seal', (_event, plaintext, password) => {
  try {
    const checksum = _sha256(String(plaintext));
    if (!password) return { ok: true, encrypted: false, checksum };
    const salt = crypto.randomBytes(16);
    const iv   = crypto.randomBytes(12);
    const key  = crypto.scryptSync(String(password), salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return {
      ok: true, encrypted: true, checksum,
      cipher: 'aes-256-gcm', kdf: 'scrypt',
      salt: salt.toString('hex'), iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
      data: enc.toString('base64'),
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

// backup-open: para bundle criptografado, descriptografa com a senha e confere
// o checksum; para não-criptografado, o renderer passa payloadStr e só conferimos
// o checksum. Retorna { ok, value, checksumOk } ou { ok:false, error }.
ipcMain.handle('backup-open', (_event, bundle, password) => {
  try {
    if (!bundle || typeof bundle !== 'object') return { ok: false, error: 'bundle inválido' };
    if (bundle.encrypted) {
      if (!password) return { ok: false, error: 'senha-necessaria' };
      const key = crypto.scryptSync(String(password), Buffer.from(bundle.salt, 'hex'), 32);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(bundle.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(bundle.authTag, 'hex'));
      const dec = Buffer.concat([decipher.update(Buffer.from(bundle.data, 'base64')), decipher.final()]).toString('utf8');
      return { ok: true, value: dec, checksumOk: _sha256(dec) === bundle.checksum };
    }
    // Não criptografado — verificação de integridade sobre a string do payload.
    const payloadStr = String(bundle.payloadStr || '');
    return { ok: true, value: payloadStr, checksumOk: _sha256(payloadStr) === bundle.checksum };
  } catch (e) {
    // Falha de GCM (senha errada ou arquivo adulterado) cai aqui.
    return { ok: false, error: 'senha-ou-integridade' };
  }
});

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-build-date', () => {
  try { return fs.statSync(app.getAppPath()).mtime.toISOString(); }
  catch { return null; }
});

ipcMain.on('check-for-updates', () => checkForUpdates(true));

// ─── WINDOW ───────────────────────────────────────────────────────
function createWindow() {
  const iconIcoPath = path.join(__dirname, 'assets', 'icon.ico');
  const iconPngPath = path.join(__dirname, 'assets', 'icon.png');
  const iconPath = fs.existsSync(iconIcoPath) ? iconIcoPath : (fs.existsSync(iconPngPath) ? iconPngPath : undefined);
  win = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    title: 'Finannza',
    icon: iconPath,
    backgroundColor: '#F1F0EC',
    show: false,
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Guardas de navegação: o app é 100% local e nunca abre novas janelas nem
  // navega para outra URL. Nega ambos — limita o alcance de um renderer
  // comprometido (não pode abrir popup nem redirecionar para site externo).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  // Minimize to tray instead of closing
  win.on('close', (event) => {
    if (tray && !isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  const menu = Menu.buildFromTemplate([
    { label: 'Arquivo', submenu: [
      { label: 'Abrir pasta de dados', click: openDataFolder },
      { type: 'separator' },
      { label: 'Verificar atualizações', click: () => checkForUpdates(true) },
      { type: 'separator' },
      { label: 'Sair', click: () => { tray = null; app.quit(); } },
    ]},
    { label: 'Editar', submenu: [{ role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Colar' }] },
    { label: 'Visualizar', submenu: [{ role: 'reload' }, { role: 'toggleDevTools', label: 'Dev Tools (F12)' }] },
  ]);
  Menu.setApplicationMenu(menu);
}

// ─── TRAY ─────────────────────────────────────────────────────────
function createTray() {
  // Use a simple 16x16 icon (generated inline to avoid needing an external file)
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  // Also update taskbar icon on Windows
  if (process.platform === 'win32' && win) {
    const taskbarIconIco = path.join(__dirname, 'assets', 'icon.ico');
    const taskbarIconPng = path.join(__dirname, 'assets', 'icon.png');
    if (fs.existsSync(taskbarIconIco)) win.setIcon(taskbarIconIco);
    else if (fs.existsSync(taskbarIconPng)) win.setIcon(taskbarIconPng);
  }
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error('empty');
  } catch {
    // Fallback: create a tiny colored square as icon
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAAQ0lEQVQ4jWNgYGD4z8DAwMBAAWAEEv+pYAYjMQaQ1QymugFUDSMphmBLkyRNkmQITm+S5AFSvE+K90nxPineJyoNADkHC2uqzDo4AAAAAElFTkSuQmCC'
    );
  }

  tray = new Tray(icon);
  tray.setToolTip('Finannza — Seu dinheiro, seus planos');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Abrir', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Sair', click: () => { tray = null; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => { win.show(); win.focus(); });
}

function openDataFolder() {
  // Ask renderer for the current data path, then open it
  win.webContents.executeJavaScript('window.__getDataPath && window.__getDataPath()')
    .then(dataPath => {
      if (dataPath) {
        const { shell } = require('electron');
        shell.openPath(path.dirname(dataPath));
      }
    }).catch(() => {});
}

// ─── MIGRAÇÃO: importar dados de instalação anterior (gastos-casal) ─
// No primeiro boot, se a pasta userData atual (Finannza) não tiver dados reais
// mas existir uma pasta irmã de uma versão antiga (ex: gastos-casal) com um
// gastos.json contendo lançamentos, oferece importar via diálogo nativo Sim/Não
// e copia o arquivo. Roda uma única vez (marcador), mesmo que o usuário recuse.

// Nomes de pasta usados por versões anteriores do app (antes do rebrand p/ Finannza).
const LEGACY_FOLDER_NAMES = ['gastos-casal', 'Gastos do Casal', 'gastos-casal-app'];

// Conta lançamentos reais num gastos.json. 0 = ausente, ilegível, vazio ou
// só com dados de teste (heurística: todos os expenses marcados _test/_seed).
function countRealExpenses(jsonPath) {
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!data || !Array.isArray(data.expenses)) return 0;
    const real = data.expenses.filter(e => e && !e._test && !e._seed && !e.isTest);
    return real.length;
  } catch { return 0; }
}

function _touchMarker(p) {
  try { fs.writeFileSync(p, new Date().toISOString(), 'utf8'); } catch { /* best-effort */ }
}

function maybeImportOrphanData() {
  try {
    const userData    = app.getPath('userData');
    const currentJson = path.join(userData, 'gastos.json');
    // Marcador: só oferece a importação uma vez, mesmo que o usuário recuse.
    const marker = path.join(userData, '.legacy-import-checked');
    if (fs.existsSync(marker)) return;

    // Se a pasta atual já tem dados reais, não há órfão a importar.
    if (countRealExpenses(currentJson) > 0) { _touchMarker(marker); return; }

    // Procura pasta irmã de versão antiga com gastos.json contendo lançamentos.
    const parent = path.dirname(userData);
    let legacyDir = null, legacyCount = 0;
    for (const name of LEGACY_FOLDER_NAMES) {
      const dir  = path.join(parent, name);
      if (path.resolve(dir) === path.resolve(userData)) continue; // nunca a própria pasta
      const json = path.join(dir, 'gastos.json');
      const n = countRealExpenses(json);
      if (n > 0) { legacyDir = dir; legacyCount = n; break; }
    }
    if (!legacyDir) { _touchMarker(marker); return; }

    const legacyName = path.basename(legacyDir);
    const plural = legacyCount === 1 ? '' : 's';
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['Sim, importar', 'Não'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'Importar dados anteriores',
      message: `Encontramos dados de uma instalação anterior (${legacyName}) com ${legacyCount} lançamento${plural}. Deseja importá-los agora?`,
      detail: 'Os dados serão copiados para a pasta atual do Finannza. Como seus dados atuais estão vazios, nada será perdido.',
    });

    if (choice === 0) {
      try {
        fs.mkdirSync(userData, { recursive: true });
        fs.copyFileSync(path.join(legacyDir, 'gastos.json'), currentJson);
        dialog.showMessageBoxSync({
          type: 'info',
          title: 'Importação concluída',
          message: `${legacyCount} lançamento${plural} importado${plural} com sucesso da instalação anterior.`,
        });
      } catch (copyErr) {
        console.error('[migração] Falha ao copiar gastos.json anterior:', copyErr.message);
        dialog.showMessageBoxSync({
          type: 'error',
          title: 'Falha na importação',
          message: 'Não foi possível copiar os dados da instalação anterior.',
          detail: copyErr.message,
        });
        return; // não grava marcador — permite tentar de novo no próximo boot
      }
    }
    _touchMarker(marker);
  } catch (e) {
    console.error('[migração] Falha ao verificar dados de instalação anterior:', e.message);
  }
}

// ─── CONTENT SECURITY POLICY ──────────────────────────────────────
// Aplicada a todas as respostas via cabeçalho HTTP. 'unsafe-inline' em
// script/style é temporário (Etapa 2B): o HTML ainda tem <script> inline e
// dezenas de onclick=/style= inline. connect-src libera só as origens que o
// renderer realmente chama via fetch:
//   - api.telegram.org        → bot interno (getUpdates/sendMessage/getMe)
//   - script.google.com       → Apps Script (syncFromSheets)
//   - script.googleusercontent.com → destino do redirect 302 do Apps Script
const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://api.telegram.org https://script.google.com https://script.googleusercontent.com",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

function applyCsp() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP_POLICY],
      },
    });
  });
}

// ─── APP LIFECYCLE ────────────────────────────────────────────────
app.whenReady().then(() => {
  _addAllowedRoot(app.getPath('userData')); // pasta de dados padrão sempre permitida
  applyCsp();
  maybeImportOrphanData(); // antes de criar a janela: renderer já lê o gastos.json importado
  createWindow();
  createTray();
  checkForUpdates();
});

app.on('before-quit', () => { isQuitting = true; });

// Prevent quitting when all windows are hidden (tray keeps app alive)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('activate', () => {
  if (win) { win.show(); win.focus(); }
});
