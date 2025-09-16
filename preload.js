const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  enableLoopbackAudio: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopbackAudio: () => ipcRenderer.invoke('disable-loopback-audio'),
  apiKey: process.env.OPENAI_KEY,
  // File system operations for logging
  writeLogFile: (filepath, content) => ipcRenderer.invoke('write-log-file', filepath, content),
  ensureLogDirectory: (dirPath) => ipcRenderer.invoke('ensure-log-directory', dirPath)
});
