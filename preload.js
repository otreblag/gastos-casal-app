const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  readFile:           (filePath)         => ipcRenderer.invoke('read-file', filePath),
  writeFile:          (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  selectFolder:       ()                 => ipcRenderer.invoke('select-folder'),
  getDefaultDataPath: ()                 => ipcRenderer.invoke('get-default-data-path'),
  pathJoin:           (...parts)         => ipcRenderer.invoke('path-join', ...parts),
  fileExists:         (filePath)         => ipcRenderer.invoke('file-exists', filePath),
  saveFileDialog:     (options)          => ipcRenderer.invoke('save-file-dialog', options),
  openFileDialog:     (options)          => ipcRenderer.invoke('open-file-dialog', options),
  getAppVersion:      ()                 => ipcRenderer.invoke('get-app-version'),
  getBuildDate:       ()                 => ipcRenderer.invoke('get-build-date'),
  checkForUpdates:    ()                 => ipcRenderer.send('check-for-updates'),
  encryptSecret:      (plain)            => ipcRenderer.invoke('encrypt-secret', plain),
  decryptSecret:      (b64)              => ipcRenderer.invoke('decrypt-secret', b64),
  backupSeal:         (plaintext, pass)  => ipcRenderer.invoke('backup-seal', plaintext, pass),
  backupOpen:         (bundle, pass)     => ipcRenderer.invoke('backup-open', bundle, pass),
  listDir:            (dirPath)          => ipcRenderer.invoke('list-dir', dirPath),
  deleteFile:         (filePath)         => ipcRenderer.invoke('delete-file', filePath),
});
