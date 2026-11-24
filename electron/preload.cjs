// The one thing the page may ask of the desktop app: appear, or go away.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sajiDesktop', {
  show: () => ipcRenderer.send('saji:show'),
  hide: () => ipcRenderer.send('saji:hide'),
  dismiss: () => ipcRenderer.send('saji:dismiss'),
})
