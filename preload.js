const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gridlabAPI', {
  getRows: (offset, limit) => ipcRenderer.invoke('get-rows', offset, limit),
  runQuery: (whereClause) => ipcRenderer.invoke('run-query', whereClause),
});