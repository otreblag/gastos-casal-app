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
});
