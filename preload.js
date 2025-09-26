const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  enableLoopbackAudio: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopbackAudio: () => ipcRenderer.invoke('disable-loopback-audio'),
  apiKey: process.env.OPENAI_KEY,
  ensureLogDirectory: (dirPath) => ipcRenderer.invoke('ensure-log-directory', dirPath),
  createLog: (sessionId, type, header) => ipcRenderer.invoke('create-log', sessionId, type, header),
  appendLog: (sessionId, type, chunk) => ipcRenderer.invoke('append-log', sessionId, type, chunk),
  finalizeLog: (sessionId, type, footer) => ipcRenderer.invoke('finalize-log', sessionId, type, footer),
  getLogStatus: (sessionId, type) => ipcRenderer.invoke('get-log-status', sessionId, type),
  setJDText: (text, options) => ipcRenderer.invoke('jd-set-text', text, options),
  getActiveJD: () => ipcRenderer.invoke('jd-get-active'),
  clearJD: () => ipcRenderer.invoke('jd-clear'),
  emitTranscriptChunk: (payload) => ipcRenderer.send('transcript-chunk', payload),
  onEvidenceUpdated: (handler) => {
    const listener = (_event, data) => handler?.(data);
    ipcRenderer.on('evidence-updated', listener);
    return () => ipcRenderer.removeListener('evidence-updated', listener);
  },
  onJDEvidenceUpdated: (handler) => {
    const listener = (_event, data) => handler?.(data);
    ipcRenderer.on('jd-evidence-updated', listener);
    return () => ipcRenderer.removeListener('jd-evidence-updated', listener);
  },
  getReasoningState: (sessionId) => ipcRenderer.invoke('reasoning-get-state', sessionId),
  onReasoningUpdate: (handler) => {
    const listener = (_event, data) => handler?.(data);
    ipcRenderer.on('reasoning-update', listener);
    return () => ipcRenderer.removeListener('reasoning-update', listener);
  },
  onGuidancePrompt: (handler) => {
    const listener = (_event, data) => handler?.(data);
    ipcRenderer.on('guidance-prompt', listener);
    return () => ipcRenderer.removeListener('guidance-prompt', listener);
  },
  onJDEvaluationPlan: (handler) => {
    const listener = (_event, data) => handler?.(data);
    ipcRenderer.on('jd-evaluation-plan', listener);
    return () => ipcRenderer.removeListener('jd-evaluation-plan', listener);
  },
  onEvaluationConflict: (handler) => {
    const listener = (_event, data) => handler?.(data);
    ipcRenderer.on('evaluation-conflict', listener);
    return () => ipcRenderer.removeListener('evaluation-conflict', listener);
  },
  exportReport: (sessionId) => ipcRenderer.invoke('export-report', sessionId),
});
