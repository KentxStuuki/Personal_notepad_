'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'The operation failed.');
  return result.data;
}

contextBridge.exposeInMainWorld('notepad', {
  platform: process.platform,

  getAppInfo: () => call('app:info'),

  openWorkspace: () => call('workspace:open'),
  restoreWorkspace: () => call('workspace:restore'),

  readDir: (dir) => call('fs:readDir', String(dir)),
  createFile: (parent, name) => call('fs:createFile', String(parent), String(name)),
  createFolder: (parent, name) => call('fs:createFolder', String(parent), String(name)),
  renameEntry: (target, newName) => call('fs:rename', String(target), String(newName)),
  deleteEntry: (target) => call('fs:delete', String(target)),
  moveEntry: (source, destDir) => call('fs:move', String(source), String(destDir)),

  /** Resolves OS drops. Paths are read from real File objects here, so renderer code cannot inject paths. */
  handleDrop: (files) => {
    const paths = [];
    for (const file of Array.from(files || []).slice(0, 50)) {
      try {
        const p = webUtils.getPathForFile(file);
        if (p) paths.push(p);
      } catch {
        /* not a real File object */
      }
    }
    return call('drop:handle', paths);
  },

  searchWorkspace: ({ query, caseSensitive, id }) =>
    call('search:workspace', { query: String(query), caseSensitive: Boolean(caseSensitive), id: Number(id) }),
  cancelSearch: () => call('search:cancel'),
  onSearchBatch: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.removeAllListeners('search:batch');
    ipcRenderer.on('search:batch', (_event, payload) => callback(payload));
  },

  readFile: (target) => call('file:read', String(target)),
  statFile: (target) => call('file:stat', String(target)),
  writeFile: ({ path, content, bom, eol, expectedMtime, force }) =>
    call('file:write', {
      path: String(path),
      content: String(content),
      bom: Boolean(bom),
      eol: eol === 'CRLF' ? 'CRLF' : 'LF',
      expectedMtime: typeof expectedMtime === 'number' ? expectedMtime : null,
      force: Boolean(force)
    }),
  saveFileDialog: (suggestedName) => call('dialog:saveAs', String(suggestedName || '')),

  onBeforeClose: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.removeAllListeners('app:before-close');
    ipcRenderer.on('app:before-close', () => callback());
  },
  confirmClose: () => call('app:confirmClose')
});
