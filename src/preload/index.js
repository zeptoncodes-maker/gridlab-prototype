import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('gridlabAPI', {
  project: {
    createDialog: (name) => ipcRenderer.invoke('project:createDialog', { name }),
    openDialog: () => ipcRenderer.invoke('project:openDialog'),
    mutationLog: () => ipcRenderer.invoke('project:mutationLog'),
  },
  dataset: {
    openCsvDialog: () => ipcRenderer.invoke('dataset:openCsvDialog'),
  },
  grid: {
    getRows: (offset, limit) => ipcRenderer.invoke('grid:getRows', offset, limit),
    runQuery: (whereClause) => ipcRenderer.invoke('grid:runQuery', whereClause),
  },
  mutations: {
    editCell: (rowId, column, newValue) =>
      ipcRenderer.invoke('mutations:editCell', { rowId, column, newValue }),
    undo: () => ipcRenderer.invoke('mutations:undo'),
  },
});
