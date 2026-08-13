"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("gridlabAPI", {
  project: {
    createDialog: (name) => electron.ipcRenderer.invoke("project:createDialog", { name }),
    openDialog: () => electron.ipcRenderer.invoke("project:openDialog"),
    mutationLog: () => electron.ipcRenderer.invoke("project:mutationLog")
  },
  dataset: {
    openCsvDialog: () => electron.ipcRenderer.invoke("dataset:openCsvDialog")
  },
  grid: {
    getRows: (offset, limit) => electron.ipcRenderer.invoke("grid:getRows", offset, limit),
    runQuery: (whereClause) => electron.ipcRenderer.invoke("grid:runQuery", whereClause)
  },
  mutations: {
    editCell: (rowId, column, newValue) => electron.ipcRenderer.invoke("mutations:editCell", { rowId, column, newValue }),
    undo: () => electron.ipcRenderer.invoke("mutations:undo")
  }
});
