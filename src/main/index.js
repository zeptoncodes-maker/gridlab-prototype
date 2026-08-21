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
    // NEW (Parquet support): accept any recorded dataset kind, not just
    // 'csv'. A Parquet-backed project used to fail BOTH branches of this
    // check silently — never re-importing, never recording its source
    // path — so writeback-on-edit would have been a no-op for it.
    const hasDataset = !!manifest.dataset?.path;
    if (!resumed && hasDataset) {
      await session.loadDataset(manifest.dataset.path);
    } else if (resumed && hasDataset) {
      // loadDataset() sets sourceFilePath/sourceFormat itself on a fresh
      // import, but resumeExistingDataset() has no way to know the
      // original file path (it only inspects local.duckdb's existing
      // schema) — record both here from the manifest so
      // exportToSourceFile() (writeback-on-edit) knows where to write AND
      // in which format.
      session.sourceFilePath = manifest.dataset.path;
      session.sourceFormat = manifest.dataset.kind === 'parquet' ? 'parquet' : 'csv';
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

// --- Cell formatting (setFormat, per spec §3.4) ---------------------------
// Deliberately its own simple mechanism, separate from the mutations.js
// pipeline — see the comment at the top of project.js for why.
//
// Where formatting is saved depends on what's actually open: inside the
// project as formats.json if one is, or as a sidecar file next to the CSV
// itself (e.g. data.csv.formats.json) if not — mirroring exactly how
// value edits already persist without a project via exportToCsv in
// duckdb.js. Only truly nowhere-to-save (no project AND no CSV ever
// loaded) falls through to the error case below.
function getFormatsFilePath() {
  if (currentProjectDir) return path.join(currentProjectDir, 'formats.json');
  if (session.sourceFilePath) return `${session.sourceFilePath}.formats.json`;
  return null;
}

ipcMain.handle('format:getAll', async () => {
  const formatsPath = getFormatsFilePath();
  if (!formatsPath) return { formats: {} };
  const formats = await project.readFormatsFile(formatsPath);
  return { formats };
});

ipcMain.handle('format:commit', async (event, entries) => {
  const formatsPath = getFormatsFilePath();
  if (!formatsPath) {
    return { ok: false, error: "Open a file first — there's nowhere to save formatting yet." };
  }
  try {
    await project.updateFormatsFile(formatsPath, entries);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Dataset loading (same behavior as the original prototype) -----------

ipcMain.handle('dataset:openCsvDialog', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Open data file',
      // NEW (Parquet support): Parquet listed first as the Tier-1 format
      // per spec §2.3. The combined filter is the default so users don't
      // have to know which format their file is before finding it.
      filters: [
        { name: 'Data files', extensions: ['parquet', 'pq', 'csv'] },
        { name: 'Parquet files', extensions: ['parquet', 'pq'] },
        { name: 'CSV files', extensions: ['csv'] },
      ],
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) return { canceled: true };
    const filePath = filePaths[0];
    // NEW: loadCsvDataset no longer returns rowCount — getting an exact
    // count now means either a live COUNT(*) scan or waiting for
    // background materialization, neither of which should block this
    // dialog from returning. The renderer never used rowCount from here
    // anyway (loadInitialWindow's own grid:getRows call gets a real,
    // current total right after this resolves).
    const { format } = await session.loadDataset(filePath);
    if (currentProjectDir) {
      // NEW (Parquet support): record the ACTUAL format rather than always
      // claiming 'csv' — the manifest is meant to describe the real
      // dataset, and a future reopen path that trusts this field would
      // otherwise read a Parquet file with the CSV reader.
      await project.updateManifest(currentProjectDir, { dataset: { kind: format, path: filePath } });
    }
    return { fileName: path.basename(filePath) };
  } catch (err) {
    return { error: err.message };
  }
});

// --- Grid reads (unchanged behavior) --------------------------------------

ipcMain.handle('grid:getRows', async (event, offset, limit) => {
  try {
    const { rows, totalRows, materializing } = await session.getRows(offset, limit);
    return { rows, totalRows, materializing, datasetLoaded: session.datasetLoaded };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('grid:runQuery', async (event, whereClause, offset, limit) => {
  try {
    const { rows, totalMatches, materializing } = await session.runQuery(whereClause, offset, limit);
    return { rows, totalMatches, materializing };
  } catch (err) {
    return { error: err.message };
  }
});

// NEW (file-open bottleneck fix): a lightweight, side-effect-free status
// check — does NOT run any query or touch the grid's data, just reads the
// in-memory flag. Lets the renderer poll for "has background
// materialization finished yet?" purely to update its status text,
// without any risk of disturbing unsaved edits the way silently
// re-fetching and remounting the grid would.
// NEW (aggregate pushdown): backs the DBSUM/DBAVG/... custom formula
// functions registered in GridPanel. Errors are returned as a value
// rather than thrown so the formula cell can show a real message instead
// of the whole calculation silently failing.
ipcMain.handle('grid:aggregate', async (event, fn, column, whereClause) => {
  try {
    const value = await session.aggregate(fn, column, whereClause);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dataset:materializationStatus', () => {
  return { materializing: session.materializing };
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

// --- Confirm dialog ---------------------------------------------------
// window.confirm() is a raw Chromium/browser API — Electron passes it
// through, but it doesn't properly participate in Electron's own
// window/focus lifecycle. Confirmed directly: after clicking OK/Cancel on
// a window.confirm() dialog, document.hasFocus() in the renderer still
// returned false, silently blocking keyboard input afterward.
// dialog.showMessageBox is Electron's OWN dialog API, built to be a
// proper modal child of a specific BrowserWindow, so it correctly hands
// focus back when dismissed.
ipcMain.handle('app:confirmDiscard', async (event, message) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Discard', 'Cancel'],
    defaultId: 1, // Cancel is the safe default — Enter shouldn't discard work
    cancelId: 1,
    message,
  });
  return result.response === 0; // true only if "Discard" was clicked
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
