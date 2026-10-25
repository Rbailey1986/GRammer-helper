const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grammar', {
  check: (text) => ipcRenderer.invoke('check', text),
  ignore: (problem, message) => ipcRenderer.invoke('ignore', problem, message),
  addWord: (word) => ipcRenderer.invoke('addWord', word),
  copy: (text) => ipcRenderer.invoke('copy', text),
  readClipboard: () => ipcRenderer.invoke('readClipboard'),
  pasteBack: (text) => ipcRenderer.invoke('pasteBack', text),
  info: () => ipcRenderer.invoke('info'),
  rewrite: (req) => ipcRenderer.invoke('rewrite', req),
  rewriterStatus: () => ipcRenderer.invoke('rewriterStatus'),
  feedback: (entry) => ipcRenderer.invoke('feedback', entry),
  onLoadText: (cb) => ipcRenderer.on('load-text', (_e, data) => cb(data)),
  onNotice: (cb) => ipcRenderer.on('notice', (_e, msg) => cb(msg)),
});
