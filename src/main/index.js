import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import { DuckDBSession } from './duckdb.js';
import * as project from './project.js';
import * as mutations from './mutations.js';

let mainWindow;

// Everything below is scoped to "the current project" — null until the
// user creates/opens one. A CSV can still be opened with no project open
// (session falls back to :memory:), but committed edits require a project
// directory to log mutations against, per spec §3.4/§3.7.
let session = new DuckDBSession(null);
let currentProjectDir = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.platform === 'darwin') {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F11' && input.type === 'keyDown') {
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
      }
    });
  }

  // electron-vite sets ELECTRON_RENDERER_URL when the dev server is running
  // (`pnpm dev`); a packaged/preview build has no dev server, so it loads
  // the built index.html straight off disk instead.
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

// --- Project lifecycle ---------------------------------------------------

ipcMain.handle('project:create', async (event, { dirPath, name }) => {
  try {
    const { manifest } = await project.createProject(dirPath, { name });
    currentProjectDir = dirPath;
    // FIX: close the previous session's DuckDB connection/instance before
    // swapping to a new one — see the close() comment in duckdb.js for why
    // this was required (Windows file-locks the .duckdb file per process).
    session.close();
    session = new DuckDBSession(project.localDuckdbPath(dirPath));
    return { ok: true, manifest };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('project:openDialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open GridLab project',
    properties: ['openDirectory'],
  });
  if (canceled || filePaths.length === 0) return { canceled: true };

  try {
    const { manifest, workbook } = await project.openProject(filePaths[0]);
    currentProjectDir = filePaths[0];
    // FIX (root cause of "Cannot open file ... being used by another
    // process"): the previous session's connection/instance was never
    // closed before pointing a new DuckDBSession at local.duckdb. On
    // Windows, DuckDB's file lock is held until the connection is
    // explicitly closed — dropping the JS reference alone doesn't release
    // it in time. See close() in duckdb.js.
    session.close();
    session = new DuckDBSession(project.localDuckdbPath(filePaths[0]));
    // FIX (edits were being silently wiped on every reopen): this used to
    // unconditionally call loadCsvDataset(manifest.dataset.path) here,
    // which re-imports straight from the ORIGINAL csv file every time —
    // even though local.duckdb already had a `dataset` table sitting in it
    // with every edit ever committed. CREATE OR REPLACE TABLE inside
    // loadCsvDataset threw that away and replaced it with a fresh,
    // untouched copy of the source CSV, every single reopen. Now:
    // resumeExistingDataset() checks whether local.duckdb already has a
    // real dataset table and reuses it as-is if so; only a genuinely new
    // project (nothing in local.duckdb yet) falls through to importing the
    // CSV for the first time.
    const resumed = await session.resumeExistingDataset();
    if (!resumed && manifest.dataset?.kind === 'csv' && manifest.dataset.path) {
      await session.loadCsvDataset(manifest.dataset.path);
    } else if (resumed && manifest.dataset?.kind === 'csv' && manifest.dataset.path) {
      // loadCsvDataset() sets csvSourcePath itself on a fresh import, but
      // resumeExistingDataset() has no way to know the original file path
      // (it only inspects local.duckdb's existing schema) — record it here
      // from the manifest so exportToCsv() (writeback-on-edit) still knows
      // where to write.
      session.csvSourcePath = manifest.dataset.path;
    }
    // FIX: this used to omit dirPath entirely — App.jsx's handleOpenProject
    // had nothing real to call setProjectDir with, so it fell back to
    // manifest.name (a display string like "my-analysis", not a real
    // filesystem path). That broke anything downstream that assumed
    // projectDir was an actual path — including making a *second*
    // "Open Project" or a subsequent commit resolve against the wrong
    // location. filePaths[0] is the actual chosen directory, mirroring
    // exactly what project:createDialog already returns for New Project.
    return { ok: true, dirPath: filePaths[0], manifest, workbook };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('project:createDialog', async (event, { name }) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a location for the new project',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || filePaths.length === 0) return { canceled: true };
  const dirPath = path.join(filePaths[0], `${name}.gridlab`);
  try {
    const { manifest } = await project.createProject(dirPath, { name });
    currentProjectDir = dirPath;
    // FIX: same close-before-swap as project:create / project:openDialog.
    session.close();
    session = new DuckDBSession(project.localDuckdbPath(dirPath));
    return { ok: true, dirPath, manifest };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('project:mutationLog', async () => {
  if (!currentProjectDir) return { entries: [] };
  const entries = await project.readMutationLog(currentProjectDir);
  return { entries };
});

// --- Dataset loading (same behavior as the original prototype) -----------

ipcMain.handle('dataset:openCsvDialog', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Open CSV file',
      filters: [{ name: 'CSV files', extensions: ['csv'] }],
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) return { canceled: true };
    const filePath = filePaths[0];
    const { rowCount } = await session.loadCsvDataset(filePath);
    if (currentProjectDir) {
      await project.updateManifest(currentProjectDir, { dataset: { kind: 'csv', path: filePath } });
    }
    return { fileName: path.basename(filePath), rowCount };
  } catch (err) {
    return { error: err.message };
  }
});

// --- Grid reads (unchanged behavior) --------------------------------------

ipcMain.handle('grid:getRows', async (event, offset, limit) => {
  try {
    const rows = await session.getRows(offset, limit);
    return { rows, datasetLoaded: session.datasetLoaded };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('grid:runQuery', async (event, whereClause) => {
  try {
    const rows = await session.runQuery(whereClause);
    return { rows };
  } catch (err) {
    return { error: err.message };
  }
});

// --- Mutation pipeline -----------------------------------------------------
// This is the one IPC channel a cell edit in Univer ultimately triggers.
// See src/renderer/src/GridPanel.jsx for where it's called from, and
// src/main/mutations.js for the propose/validate/dry-run/diff/commit chain.

ipcMain.handle('mutations:editCell', async (event, { rowId, column, newValue }) => {
  try {
    const result = await mutations.proposeValidateAndCommit({
      rowId,
      column,
      newValue,
      session,
      projectDir: currentProjectDir,
    });
    return result;
  } catch (err) {
    return { ok: false, stage: 'unexpected', error: err.message };
  }
});

ipcMain.handle('mutations:undo', async () => {
  if (!currentProjectDir) {
    return { ok: false, error: 'Undo needs an open project — the log lives in mutations.ndjson.' };
  }
  try {
    return await mutations.undoLastMutation({ session, projectDir: currentProjectDir });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
