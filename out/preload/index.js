"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("gridlabAPI", {
  project: {
    createDialog: (name) => electron.ipcRenderer.invoke("project:createDialog", { name }),
    openDialog: () => electron.ipcRenderer.invoke("project:openDialog"),
    mutationLog: () => electron.ipcRenderer.invoke("project:mutationLog")
  },
  dataset: {
    openCsvDialog: () => electron.ipcRenderer.invoke("dataset:openCsvDialog"),
    materializationStatus: () => electron.ipcRenderer.invoke("dataset:materializationStatus")
  },
  grid: {
    getRows: (offset, limit) => electron.ipcRenderer.invoke("grid:getRows", offset, limit),
    runQuery: (whereClause, offset, limit) => electron.ipcRenderer.invoke("grid:runQuery", whereClause, offset, limit),
    aggregate: (fn, column, whereClause) => electron.ipcRenderer.invoke("grid:aggregate", fn, column, whereClause)
  },
  mutations: {
    editCell: (rowId, column, newValue) => electron.ipcRenderer.invoke("mutations:editCell", { rowId, column, newValue }),
    undo: () => electron.ipcRenderer.invoke("mutations:undo")
  },
  app: {
    confirmDiscard: (message) => electron.ipcRenderer.invoke("app:confirmDiscard", message)
  },
  formula: {
    getAll: () => electron.ipcRenderer.invoke("formula:getAll"),
    commit: (entries) => electron.ipcRenderer.invoke("formula:commit", entries)
  },
  format: {
    getAll: () => electron.ipcRenderer.invoke("format:getAll"),
    commit: (entries) => electron.ipcRenderer.invoke("format:commit", entries)
  }
});
