'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const appConfig = require('./app.config.json');
const pkg = require('./package.json');

const fsp = fs.promises;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md']);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 5 * 1024 * 1024;
const MAX_OCCURRENCES_PER_FILE = 50;
const MAX_STORED_OCCURRENCES = 2000;
const MAX_FILES_SCANNED = 20000;
const INDEX_URL = pathToFileURL(path.join(__dirname, 'index.html')).href;

// Display name comes from app.config.json; user data stays under the internal package id so a rename never orphans preferences.
app.setName(appConfig.productName);
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), pkg.name));
if (IS_WIN) app.setAppUserModelId(appConfig.appId);

const perf = appConfig.performance || {};
if (perf.disableHardwareAcceleration) app.disableHardwareAcceleration();
if (Array.isArray(perf.disableFeatures) && perf.disableFeatures.length) {
  app.commandLine.appendSwitch('disable-features', perf.disableFeatures.join(','));
}

let mainWindow = null;
let workspaceRoot = null;
let closeConfirmed = false;
const approvedFiles = new Set(); // files outside the workspace chosen through the native save dialog

/** Error whose message is safe to show to the user. */
class AppError extends Error {}

/* ------------------------------------------------------------------ */
/* Preferences (main-process only; never trusted from the renderer)    */
/* ------------------------------------------------------------------ */

const prefsPath = () => path.join(app.getPath('userData'), 'preferences.json');

async function readPrefs() {
  try {
    return JSON.parse(await fsp.readFile(prefsPath(), 'utf8'));
  } catch {
    return {};
  }
}

async function writePrefs(prefs) {
  try {
    await fsp.mkdir(path.dirname(prefsPath()), { recursive: true });
    await fsp.writeFile(prefsPath(), JSON.stringify(prefs));
  } catch {
    /* preferences are best-effort */
  }
}

/* ------------------------------------------------------------------ */
/* Path safety                                                         */
/* ------------------------------------------------------------------ */

const norm = (p) => (IS_WIN ? p.toLowerCase() : p);
const samePath = (a, b) => norm(a) === norm(b);

function isInside(parent, target) {
  const rel = path.relative(norm(parent), norm(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** Resolves symlinks for the deepest existing ancestor, so not-yet-created paths are checked too. */
async function realResolve(p) {
  const abs = path.resolve(p);
  try {
    return await fsp.realpath(abs);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const parent = path.dirname(abs);
    if (parent === abs) throw err;
    return path.join(await realResolve(parent), path.basename(abs));
  }
}

function assertPathArg(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0')) {
    throw new AppError('Invalid path.');
  }
}

async function resolveInWorkspace(p, { allowRoot = true } = {}) {
  if (!workspaceRoot) throw new AppError('No workspace is open.');
  assertPathArg(p);
  const real = await realResolve(p);
  if (!isInside(workspaceRoot, real)) throw new AppError('Path is outside the workspace.');
  if (!allowRoot && samePath(real, workspaceRoot)) throw new AppError('The workspace folder itself cannot be modified.');
  return real;
}

/** A file the renderer may read or write: inside the workspace, or approved through a native dialog. */
async function resolveFile(p) {
  assertPathArg(p);
  const real = await realResolve(p);
  if (workspaceRoot && isInside(workspaceRoot, real)) return real;
  if (approvedFiles.has(norm(real))) return real;
  throw new AppError('Access to this file is not permitted.');
}

function validateName(name) {
  if (typeof name !== 'string') throw new AppError('Invalid name.');
  const n = name.trim();
  if (!n) throw new AppError('Name cannot be empty.');
  if (n.length > 200) throw new AppError('Name is too long.');
  if (n.startsWith('.')) throw new AppError('Names cannot start with a dot.');
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(n)) throw new AppError('Name contains invalid characters.');
  if (/[. ]$/.test(n)) throw new AppError('Name cannot end with a dot or space.');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) throw new AppError('This name is reserved by the system.');
  return n;
}

function fileNameWithExtension(name, defaultExt) {
  const n = validateName(name);
  const ext = path.extname(n).toLowerCase();
  if (!ext) return n + defaultExt;
  if (!SUPPORTED_EXTENSIONS.has(ext)) throw new AppError('Only .txt and .md files are supported.');
  return n;
}

const isSupportedFile = (p) => SUPPORTED_EXTENSIONS.has(path.extname(p).toLowerCase());

function toUserMessage(err) {
  if (err instanceof AppError) return err.message;
  switch (err && err.code) {
    case 'ENOENT': return 'The file or folder no longer exists.';
    case 'EEXIST': return 'An item with that name already exists.';
    case 'EACCES':
    case 'EPERM': return 'Permission denied.';
    case 'EBUSY': return 'The file is in use by another program.';
    case 'ENOTDIR': return 'The target is not a folder.';
    case 'EISDIR': return 'The target is a folder.';
    case 'ENOSPC': return 'Not enough disk space.';
    default: return 'The operation failed.';
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function isTrustedSender(event) {
  return Boolean(
    mainWindow &&
      event.sender === mainWindow.webContents &&
      event.senderFrame &&
      typeof event.senderFrame.url === 'string' &&
      event.senderFrame.url.startsWith(INDEX_URL)
  );
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'Unauthorized request.' };
    try {
      return { ok: true, data: await fn(event, ...args) };
    } catch (err) {
      return { ok: false, error: toUserMessage(err) };
    }
  });
}

async function setWorkspace(dir) {
  const real = await fsp.realpath(dir);
  if (!(await fsp.stat(real)).isDirectory()) throw new AppError('Selected path is not a folder.');
  workspaceRoot = real;
  const prefs = await readPrefs();
  prefs.lastWorkspace = real;
  await writePrefs(prefs);
  return { path: real, name: path.basename(real) || real };
}

handle('workspace:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return setWorkspace(result.filePaths[0]);
});

handle('workspace:restore', async () => {
  const { lastWorkspace } = await readPrefs();
  if (typeof lastWorkspace !== 'string') return null;
  try {
    return await setWorkspace(lastWorkspace);
  } catch {
    return null;
  }
});

handle('fs:readDir', async (_e, dir) => {
  const real = await resolveInWorkspace(dir);
  const entries = await fsp.readdir(real, { withFileTypes: true });
  return entries
    .filter((d) => !d.name.startsWith('.'))
    .map((d) => {
      const isDir = d.isDirectory();
      return {
        name: d.name,
        path: path.join(real, d.name),
        type: isDir ? 'dir' : 'file',
        supported: !isDir && d.isFile() && isSupportedFile(d.name)
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
});

handle('fs:createFile', async (_e, parent, name) => {
  const parentReal = await resolveInWorkspace(parent);
  if (!(await fsp.stat(parentReal)).isDirectory()) throw new AppError('The target is not a folder.');
  const target = await resolveInWorkspace(path.join(parentReal, fileNameWithExtension(name, '.txt')));
  await fsp.writeFile(target, '', { flag: 'wx' });
  const st = await fsp.stat(target);
  return { path: target, mtime: st.mtimeMs };
});

handle('fs:createFolder', async (_e, parent, name) => {
  const parentReal = await resolveInWorkspace(parent);
  if (!(await fsp.stat(parentReal)).isDirectory()) throw new AppError('The target is not a folder.');
  const target = await resolveInWorkspace(path.join(parentReal, validateName(name)));
  await fsp.mkdir(target);
  return { path: target };
});

handle('fs:rename', async (_e, source, newName) => {
  const src = await resolveInWorkspace(source, { allowRoot: false });
  const st = await fsp.lstat(src);
  let finalName;
  if (st.isDirectory()) {
    finalName = validateName(newName);
  } else if (st.isFile() && isSupportedFile(src)) {
    finalName = fileNameWithExtension(newName, path.extname(src));
  } else {
    throw new AppError('Only .txt and .md files can be renamed here.');
  }
  const dest = await resolveInWorkspace(path.join(path.dirname(src), finalName), { allowRoot: false });
  if (dest === src) return { path: src };
  const existing = await fsp.lstat(dest).catch(() => null);
  if (existing && !(existing.ino !== 0 && existing.ino === st.ino && existing.dev === st.dev)) {
    throw new AppError('An item with that name already exists.');
  }
  await fsp.rename(src, dest);
  return { path: dest };
});

handle('fs:delete', async (_e, target) => {
  const real = await resolveInWorkspace(target, { allowRoot: false });
  const st = await fsp.lstat(real);
  if (!st.isDirectory() && !(st.isFile() && isSupportedFile(real))) {
    throw new AppError('Only .txt and .md files and folders can be deleted here.');
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Confirm delete',
    message: `Delete "${path.basename(real)}"?`,
    detail: st.isDirectory()
      ? 'This folder and everything inside it will be moved to the trash.'
      : 'This file will be moved to the trash.',
    buttons: ['Move to Trash', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
  if (response !== 0) return { deleted: false };
  try {
    await shell.trashItem(real);
  } catch {
    throw new AppError('Could not move the item to the trash.');
  }
  return { deleted: true };
});

handle('file:read', async (_e, target) => {
  const real = await resolveFile(target);
  const st = await fsp.stat(real);
  if (!st.isFile()) throw new AppError('The target is not a file.');
  if (!isSupportedFile(real)) throw new AppError('Only .txt and .md files can be opened.');
  if (st.size > MAX_FILE_BYTES) throw new AppError('File is too large (limit 10 MB).');
  const buf = await fsp.readFile(real);
  if (buf.includes(0)) throw new AppError('This file appears to be binary and cannot be opened.');
  approvedFiles.add(norm(real));
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = buf.toString('utf8', bom ? 3 : 0);
  const eol = text.includes('\r\n') ? 'CRLF' : 'LF';
  return {
    path: real,
    content: eol === 'CRLF' ? text.replace(/\r\n/g, '\n') : text,
    bom,
    eol,
    mtime: st.mtimeMs
  };
});

handle('file:stat', async (_e, target) => {
  const real = await resolveFile(target);
  try {
    const st = await fsp.stat(real);
    return { exists: st.isFile(), mtime: st.mtimeMs };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, mtime: null };
    throw err;
  }
});

handle('file:write', async (_e, req) => {
  if (!req || typeof req !== 'object' || typeof req.content !== 'string') throw new AppError('Invalid request.');
  const real = await resolveFile(req.path);
  if (!isSupportedFile(real)) throw new AppError('Only .txt and .md files can be saved.');
  const expected = typeof req.expectedMtime === 'number' ? req.expectedMtime : null;
  if (expected !== null && !req.force) {
    const st = await fsp.stat(real).catch(() => null);
    if (st && st.mtimeMs !== expected) return { conflict: true };
  }
  const body = (req.eol === 'CRLF' ? req.content.replace(/\n/g, '\r\n') : req.content);
  const data = Buffer.from((req.bom ? '\uFEFF' : '') + body, 'utf8');
  if (data.length > MAX_FILE_BYTES * 2) throw new AppError('Document is too large to save.');
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, real);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
  const st = await fsp.stat(real);
  return { conflict: false, mtime: st.mtimeMs };
});

handle('dialog:saveAs', async (_e, suggestedName) => {
  let base = 'Untitled.txt';
  try {
    base = fileNameWithExtension(path.basename(String(suggestedName || '')), '.txt');
  } catch {
    /* fall back to the default name */
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save File',
    defaultPath: path.join(workspaceRoot || app.getPath('documents'), base),
    filters: [{ name: 'Text and Markdown', extensions: ['txt', 'md'] }]
  });
  if (result.canceled || !result.filePath) return null;
  let chosen = result.filePath;
  if (!isSupportedFile(chosen)) {
    chosen += '.txt';
    if (await fsp.stat(chosen).then(() => true, () => false)) {
      throw new AppError('A file with that name already exists. Choose a different name.');
    }
  }
  const real = await realResolve(chosen);
  approvedFiles.add(norm(real));
  return { path: real };
});


handle('app:info', async () => ({
  productName: appConfig.productName,
  description: appConfig.description,
  version: app.getVersion()
}));

/**
 * Files and folders dropped from the OS. The paths come from preload (webUtils.getPathForFile on real File
 * objects), never from renderer-supplied strings.
 */
handle('drop:handle', async (_e, paths) => {
  if (!Array.isArray(paths) || paths.length > 50) throw new AppError('Invalid drop.');
  const result = { workspace: null, files: [], skipped: 0, extraFolders: 0, errors: [] };
  let folders = 0;
  for (const p of paths) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) {
      result.skipped++;
      continue;
    }
    let real;
    let st;
    try {
      real = await fsp.realpath(p);
      st = await fsp.stat(real);
    } catch (err) {
      result.errors.push(toUserMessage(err));
      continue;
    }
    if (st.isDirectory()) {
      folders++;
      if (!result.workspace) {
        try {
          await fsp.readdir(real);
          result.workspace = await setWorkspace(real);
        } catch (err) {
          result.errors.push(toUserMessage(err));
        }
      }
    } else if (st.isFile() && isSupportedFile(real) && st.size <= MAX_FILE_BYTES) {
      approvedFiles.add(norm(real));
      result.files.push({ path: real, name: path.basename(real) });
    } else {
      result.skipped++;
    }
  }
  result.extraFolders = Math.max(0, folders - (result.workspace ? 1 : 0) - result.errors.length);
  return result;
});

handle('fs:move', async (_e, source, destDir) => {
  const src = await resolveInWorkspace(source, { allowRoot: false });
  const dest = await resolveInWorkspace(destDir);
  const st = await fsp.lstat(src);
  if (!st.isDirectory() && !(st.isFile() && isSupportedFile(src))) {
    throw new AppError('Only .txt and .md files and folders can be moved here.');
  }
  if (!(await fsp.stat(dest)).isDirectory()) throw new AppError('The destination is not a folder.');
  if (st.isDirectory() && isInside(src, dest)) {
    throw new AppError('A folder cannot be moved into itself or one of its subfolders.');
  }
  if (samePath(path.dirname(src), dest)) return { path: src, unchanged: true };
  const target = await resolveInWorkspace(path.join(dest, path.basename(src)), { allowRoot: false });
  if (await fsp.lstat(target).then(() => true, () => false)) {
    throw new AppError(`"${path.basename(src)}" already exists in the destination folder. Nothing was moved.`);
  }
  try {
    await fsp.rename(src, target);
  } catch (err) {
    if (err.code === 'EXDEV') throw new AppError('Items cannot be moved across drives.');
    throw err;
  }
  return { path: target };
});

/* ---------------- workspace search ---------------- */

let searchSeq = 0;

handle('search:cancel', async () => {
  searchSeq++;
  return true;
});

handle('search:workspace', async (event, req) => {
  if (!workspaceRoot) throw new AppError('No workspace is open.');
  if (!req || typeof req.query !== 'string' || typeof req.id !== 'number') throw new AppError('Invalid request.');
  if (!req.query || req.query.length > 200) throw new AppError('Invalid search text.');
  const re = new RegExp(req.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), req.caseSensitive === true ? 'g' : 'gi');
  const mySeq = ++searchSeq;
  const wc = event.sender;

  let batch = [];
  let lastFlush = Date.now();
  let stored = 0;
  let totalOccurrences = 0;
  let totalFiles = 0;
  let scanned = 0;
  let truncated = false;
  const flush = (force) => {
    if (batch.length && (force || batch.length >= 20 || Date.now() - lastFlush > 120)) {
      wc.send('search:batch', { id: req.id, files: batch });
      batch = [];
      lastFlush = Date.now();
    }
  };

  const stack = [workspaceRoot];
  scan: while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // inaccessible folder: skip
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const subdirs = [];
    for (const d of entries) {
      if (mySeq !== searchSeq) return { id: req.id, cancelled: true };
      if (d.name.startsWith('.') || d.name === 'node_modules') continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        subdirs.push(full);
        continue;
      }
      if (!d.isFile() || !isSupportedFile(d.name)) continue;
      if (++scanned > MAX_FILES_SCANNED) {
        truncated = true;
        break scan;
      }
      let buf;
      try {
        if ((await fsp.stat(full)).size > MAX_SEARCH_FILE_BYTES) continue;
        buf = await fsp.readFile(full);
      } catch {
        continue; // unreadable file: skip
      }
      if (buf.includes(0)) continue;
      const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      let text = buf.toString('utf8', bom ? 3 : 0);
      if (text.includes('\r')) text = text.replace(/\r\n/g, '\n');

      const occurrences = [];
      let count = 0;
      let line = 1;
      let countedTo = 0;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        count++;
        if (occurrences.length < MAX_OCCURRENCES_PER_FILE && stored + occurrences.length < MAX_STORED_OCCURRENCES) {
          for (let i = text.indexOf('\n', countedTo); i !== -1 && i < m.index; i = text.indexOf('\n', countedTo)) {
            line++;
            countedTo = i + 1;
          }
          const lineStart = m.index === 0 ? 0 : text.lastIndexOf('\n', m.index - 1) + 1;
          let lineEnd = text.indexOf('\n', m.index);
          if (lineEnd === -1) lineEnd = text.length;
          const from = Math.max(lineStart, m.index - 50);
          const to = Math.min(lineEnd, m.index + m[0].length + 100);
          const lead = from > lineStart ? '…' : '';
          occurrences.push({
            index: m.index,
            length: m[0].length,
            line,
            preview: lead + text.slice(from, to) + (to < lineEnd ? '…' : ''),
            matchStart: lead.length + (m.index - from)
          });
        }
        if (count >= 20000) break;
      }
      if (count > 0) {
        totalFiles++;
        totalOccurrences += count;
        stored += occurrences.length;
        batch.push({ path: full, name: d.name, rel: path.relative(workspaceRoot, full), count, occurrences });
        flush(false);
        if (stored >= MAX_STORED_OCCURRENCES) {
          truncated = true;
          break scan;
        }
      }
    }
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
  flush(true);
  return { id: req.id, done: true, totalFiles, totalOccurrences, truncated, scanned };
});

handle('app:confirmClose', async () => {
  closeConfirmed = true;
  if (mainWindow) mainWindow.close();
  return true;
});

/* ------------------------------------------------------------------ */
/* Window and lifecycle                                                */
/* ------------------------------------------------------------------ */

function buildMenu() {
  if (!IS_MAC) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] }
    ])
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: appConfig.productName,
    backgroundColor: '#1e1f22',
    icon: path.join(__dirname, 'assets', 'icons', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
      spellcheck: false
    }
  });

  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('page-title-updated', (e) => e.preventDefault());
  wc.on('render-process-gone', () => {
    closeConfirmed = true;
  });
  wc.on('context-menu', (_e, params) => {
    if (!params.isEditable && !params.selectionText) return;
    const f = params.editFlags;
    Menu.buildFromTemplate([
      { role: 'undo', enabled: f.canUndo },
      { role: 'redo', enabled: f.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: f.canCut },
      { role: 'copy', enabled: f.canCopy },
      { role: 'paste', enabled: f.canPaste },
      { role: 'selectAll', enabled: f.canSelectAll }
    ]).popup({ window: mainWindow });
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (e) => {
    if (closeConfirmed) return;
    e.preventDefault();
    wc.send('app:before-close');
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // Enforce offline operation: block every network request and permission prompt.
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, callback) => callback({ cancel: true })
    );
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        closeConfirmed = false;
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => app.quit());
}
