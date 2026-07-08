const { app, BrowserWindow, Menu, Tray, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs   = require('fs');
const { autoUpdater } = require('electron-updater');

let win  = null;
let tray = null;

// ─── AUTO UPDATE (electron-updater + GitHub Releases) ─────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', (info) => {
  console.log(`[updater] Atualização disponível: v${info.version}`);
});

autoUpdater.on('update-downloaded', (info) => {
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
    if (response === 0) autoUpdater.quitAndInstall();
  });
});

autoUpdater.on('error', (err) => {
  console.error('[updater] Erro ao verificar/baixar atualização:', err == null ? 'desconhecido' : (err.stack || err).toString());
});

function checkForUpdates() {
  if (!app.isPackaged) {
    console.log('[updater] Ignorado — app rodando em modo de desenvolvimento (não empacotado).');
    return;
  }
  autoUpdater.checkForUpdatesAndNotify().catch(err => {
    console.error('[updater] Falha ao verificar atualizações:', err);
  });
}

// ─── IPC HANDLERS ────────────────────────────────────────────────
ipcMain.handle('read-file', (_event, filePath) => {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
});

ipcMain.handle('write-file', (_event, filePath, content) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('get-default-data-path', () => {
  return app.getPath('userData');
});

ipcMain.handle('path-join', (_event, ...parts) => {
  return path.join(...parts);
});

ipcMain.handle('file-exists', (_event, filePath) => {
  return fs.existsSync(filePath);
});

ipcMain.handle('save-file-dialog', async (_event, options) => {
  const result = await dialog.showSaveDialog(win, options);
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('open-file-dialog', async (_event, options) => {
  const result = await dialog.showOpenDialog(win, { ...options, properties: ['openFile'] });
  return result.canceled ? null : result.filePaths[0];
});

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
      preload: path.join(__dirname, 'preload.js'),
    },
    title: 'Finannza',
    icon: iconPath,
    backgroundColor: '#F1F0EC',
    show: false,
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Minimize to tray instead of closing
  win.on('close', (event) => {
    if (tray) {
      event.preventDefault();
      win.hide();
    }
  });

  const menu = Menu.buildFromTemplate([
    { label: 'Arquivo', submenu: [
      { label: 'Abrir pasta de dados', click: openDataFolder },
      { type: 'separator' },
      { label: 'Verificar atualizações', click: checkForUpdates },
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

// ─── APP LIFECYCLE ────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  createTray();
  checkForUpdates();
});

// Prevent quitting when all windows are hidden (tray keeps app alive)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('activate', () => {
  if (win) { win.show(); win.focus(); }
});
