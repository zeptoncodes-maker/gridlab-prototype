import React, { useState, useCallback, useRef, useEffect } from 'react';
import GridPanel from './GridPanel.jsx';
import MutationPanel from './MutationPanel.jsx';

export default function App() {
  const [statusText, setStatusText] = useState('DuckDB connected · local (no project open)');
  const [dims, setDims] = useState({ rows: 0, cols: 0 });
  const [mutationLogVersion, setMutationLogVersion] = useState(0); // bump to make MutationPanel refetch
  const [projectDir, setProjectDir] = useState(null);
  const [pendingCount, setPendingCount] = useState(0); // unsaved edits currently staged in GridPanel
  const [mutationPanelOpen, setMutationPanelOpen] = useState(false); // Mutation Log is now a toggleable drawer, not a permanent sidebar — see openNewProjectModal's comment on why the grid needed the full width back

  // New-project name entry. window.prompt() is not implemented in
  // Electron's renderer at all (Electron supports alert()/confirm() but
  // deliberately never shipped prompt() — see electron/electron#472) — it
  // just returns null immediately with no dialog ever appearing, which is
  // exactly why "New Project…" looked like it did nothing. This modal
  // replaces it with a plain controlled input styled to match the app.
  const [newProjectModalOpen, setNewProjectModalOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('my-analysis');
  const newProjectInputRef = useRef(null);

  const bumpMutationLog = useCallback(() => setMutationLogVersion((v) => v + 1), []);
  // FIX (reported bug: History panel's Undo reverted the value in DuckDB
  // but the grid kept showing the OLD value): mutationLogVersion is only
  // wired to MutationPanel's refreshKey — GridPanel never learned the
  // underlying data had changed underneath it, so it kept displaying
  // stale cells after an undo. This is a SEPARATE counter from
  // mutationLogVersion on purpose: mutationLogVersion also bumps on every
  // ordinary Save (onMutationCommitted), and a Save must NOT trigger a
  // grid reload — the grid already shows exactly what was just saved, so
  // reloading would be pure waste and would disrupt column widths/scroll
  // position for no reason. Only a genuine EXTERNAL change to the data
  // (i.e. an undo from the History panel) bumps this one.
  const [gridDataVersion, setGridDataVersion] = useState(0);
  const handleMutationUndone = useCallback(() => {
    bumpMutationLog();
    setGridDataVersion((v) => v + 1);
  }, [bumpMutationLog]);

  useEffect(() => {
    if (newProjectModalOpen) {
      // Autofocus + select-all so typing immediately replaces the default
      // name, matching how a native prompt() would behave.
      newProjectInputRef.current?.focus();
      newProjectInputRef.current?.select();
    }
  }, [newProjectModalOpen]);

  async function openNewProjectModal() {
    // FIX: switching projects remounts GridPanel's whole grid from scratch,
    // which would otherwise silently throw away any unsaved (staged but
    // not yet Saved) edits with no warning at all.
    if (pendingCount > 0 && !(await confirmDiscardForProjectSwitch())) return;
    setNewProjectName('my-analysis');
    setNewProjectModalOpen(true);
  }

  function closeNewProjectModal() {
    setNewProjectModalOpen(false);
  }

  async function confirmNewProject() {
    const name = newProjectName.trim();
    if (!name) return;
    setNewProjectModalOpen(false);
    const result = await window.gridlabAPI.project.createDialog(name);
    if (result.canceled) return;
    if (!result.ok) {
      alert(`Couldn't create project: ${result.error}`);
      return;
    }
    setProjectDir(result.dirPath);
    setStatusText(`DuckDB connected · project: ${name}`);
    bumpMutationLog();
  }

  // FIX: see the matching comment on confirmDiscardPendingEdits in
  // GridPanel.jsx — window.confirm() doesn't properly participate in
  // Electron's window/focus lifecycle (confirmed: document.hasFocus()
  // stayed false afterward, even after an explicit main-process
  // BrowserWindow.focus() call). Using Electron's own dialog.showMessageBox
  // via IPC instead — it's a proper modal child of the BrowserWindow and
  // correctly restores focus on its own.
  async function confirmDiscardForProjectSwitch() {
    return window.gridlabAPI.app.confirmDiscard(
      `You have ${pendingCount} unsaved change${pendingCount === 1 ? '' : 's'} in the current dataset. Discard ${pendingCount === 1 ? 'it' : 'them'} and continue?`
    );
  }

  async function handleOpenProject() {
    if (pendingCount > 0 && !(await confirmDiscardForProjectSwitch())) return;
    const result = await window.gridlabAPI.project.openDialog();
    if (result.canceled) return;
    if (!result.ok) {
      alert(`Couldn't open project: ${result.error}`);
      return;
    }
    // FIX: this used to be result.manifest.name — a display string like
    // "my-analysis", not a real filesystem path. projectDir needs to be an
    // actual directory (same as handleNewProject already uses result.dirPath)
    // since everything downstream — the mutation log, undo, appendMutation —
    // resolves paths against it directly.
    setProjectDir(result.dirPath);
    setStatusText(`DuckDB connected · project: ${result.manifest.name}`);
    bumpMutationLog();
  }

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <h1>GridLab</h1>
          <span className="dims">
            <span>{dims.rows.toLocaleString()}</span>
            <span className="x">×</span>
            <span>{dims.cols}</span>
          </span>
        </div>
        <div className="topbar-right">
          <div className="source-actions">
            <button className="ghost" onClick={openNewProjectModal}>New Project…</button>
            <button className="ghost" onClick={handleOpenProject}>Open Project…</button>
            <button className="ghost" onClick={() => setMutationPanelOpen(true)}>History</button>
          </div>
          <div className="status">
            <span className="dot" />
            <span>{statusText}</span>
          </div>
        </div>
      </div>

      <div className="workarea">
        <GridPanel
          projectDir={projectDir}
          onDimsChange={setDims}
          onStatusChange={setStatusText}
          onMutationCommitted={bumpMutationLog}
          onPendingChange={setPendingCount}
          gridDataVersion={gridDataVersion}
        />
      </div>

      {mutationPanelOpen && (
        <div className="mutationDrawerOverlay" onMouseDown={() => setMutationPanelOpen(false)}>
          <div onMouseDown={(e) => e.stopPropagation()}>
            <MutationPanel
              projectDir={projectDir}
              refreshKey={mutationLogVersion}
              onUndo={handleMutationUndone}
              onClose={() => setMutationPanelOpen(false)}
            />
          </div>
        </div>
      )}

      {newProjectModalOpen && (
        <div className="modalOverlay" onMouseDown={closeNewProjectModal}>
          <div className="modalDialog" onMouseDown={(e) => e.stopPropagation()}>
            <h2>New project</h2>
            <label htmlFor="newProjectNameInput">Project name</label>
            <input
              id="newProjectNameInput"
              ref={newProjectInputRef}
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmNewProject();
                if (e.key === 'Escape') closeNewProjectModal();
              }}
            />
            <div className="modalActions">
              <button className="ghost" onClick={closeNewProjectModal}>Cancel</button>
              <button onClick={confirmNewProject} disabled={!newProjectName.trim()}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
