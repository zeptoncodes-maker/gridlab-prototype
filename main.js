const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const duckdb = require('@duckdb/node-api');

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile('index.html');
}

ipcMain.handle('get-rows', async (event, offset, limit) => {
  const instance = await duckdb.DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const result = await connection.run(
    `SELECT range AS id, 'Person_' || range AS name, (range % 50) + 18 AS age
     FROM range(100000)
     LIMIT ${limit} OFFSET ${offset}`
  );
  const rows = await result.getRowObjects();
  return rows;
});

ipcMain.handle('run-query', async (event, whereClause) => {
  const instance = await duckdb.DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const safeWhere = whereClause.trim() || '1=1';
  const result = await connection.run(
    `SELECT range AS id, 'Person_' || range AS name, (range % 50) + 18 AS age
     FROM range(100000)
     WHERE ${safeWhere}
     LIMIT 200`
  );
  const rows = await result.getRowObjects();
  return rows;
});

app.whenReady().then(createWindow);