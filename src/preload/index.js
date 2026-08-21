import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('gridlabAPI', {
  project: {
    createDialog: (name) => ipcRenderer.invoke('project:createDialog', { name }),
    openDialog: () => ipcRenderer.invoke('project:openDialog'),
    mutationLog: () => ipcRenderer.invoke('project:mutationLog'),
  },
  dataset: {
    openCsvDialog: () => ipcRenderer.invoke('dataset:openCsvDialog'),
    materializationStatus: () => ipcRenderer.invoke('dataset:materializationStatus'),
  },
  grid: {
    getRows: (offset, limit) => ipcRenderer.invoke('grid:getRows', offset, limit),
    runQuery: (whereClause, offset, limit) => ipcRenderer.invoke('grid:runQuery', whereClause, offset, limit),
    aggregate: (fn, column, whereClause) => ipcRenderer.invoke('grid:aggregate', fn, column, whereClause),
  },
  mutations: {
    editCell: (rowId, column, newValue) =>
      ipcRenderer.invoke('mutations:editCell', { rowId, column, newValue }),
    undo: () => ipcRenderer.invoke('mutations:undo'),
  },
  app: {
    confirmDiscard: (message) => ipcRenderer.invoke('app:confirmDiscard', message),
  },
  format: {
    getAll: () => ipcRenderer.invoke('format:getAll'),
    commit: (entries) => ipcRenderer.invoke('format:commit', entries),
  },
});
