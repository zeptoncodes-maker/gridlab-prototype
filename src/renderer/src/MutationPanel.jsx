import React, { useEffect, useState } from 'react';

export default function MutationPanel({ projectDir, refreshKey, onUndo }) {
  const [entries, setEntries] = useState([]);
  const [undoError, setUndoError] = useState(null);

  useEffect(() => {
    if (!projectDir) {
      setEntries([]);
      return;
    }
    window.gridlabAPI.project.mutationLog().then((res) => setEntries(res.entries || []));
  }, [projectDir, refreshKey]);

  async function handleUndo() {
    setUndoError(null);
    const result = await window.gridlabAPI.mutations.undo();
    if (!result.ok) {
      setUndoError(result.error);
      return;
    }
    onUndo();
  }

  return (
    <div className="mutationPanel">
      <div className="mutationPanelHeader">
        <span>Mutation log</span>
        <button className="ghost" onClick={handleUndo} disabled={entries.length === 0}>
          Undo last
        </button>
      </div>

      {!projectDir && (
        <div className="mutationPanelEmpty">
          No project open — edits still apply to the in-memory dataset, but nothing is logged or
          undoable until you create or open a project.
        </div>
      )}

      {undoError && <div className="errorBanner">{undoError}</div>}

      {projectDir && entries.length === 0 && (
        <div className="mutationPanelEmpty">No mutations yet. Edit a cell to see it here.</div>
      )}

      <ul className="mutationList">
        {entries
          .slice()
          .reverse()
          .map((entry) => (
            <li key={entry.id} className="mutationEntry">
              <div className="mutationEntryIntent">{entry.intent}</div>
              <div className="mutationEntryDiff">{entry.diff?.summary}</div>
              <div className="mutationEntryMeta">
                {entry.origin?.kind} · {formatTime(entry.committedAt)}
              </div>
            </li>
          ))}
      </ul>
    </div>
  );
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}
