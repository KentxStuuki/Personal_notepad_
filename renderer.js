(function () {
  'use strict';

  const NP = window.NP;
  const { storage } = NP;
  const $ = (id) => document.getElementById(id);

  const sidebar = $('sidebar');
  const resizer = $('sidebar-resizer');
  const appEl = $('app');
  const MIN_SIDEBAR = 180;
  const MAX_SIDEBAR = 520;
  const FOCUS_SYNC_MIN_MS = 4000;

  /* ---------------- branding (name comes from app.config.json via the main process) ---------------- */

  NP.api.getAppInfo().then((info) => {
    document.title = info.productName;
    for (const node of document.querySelectorAll('[data-app-name]')) node.textContent = info.productName;
  }).catch(() => {});

  /* ---------------- theme ---------------- */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    storage.set('theme', theme);
    $('btn-theme').title = theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme';
  }

  $('btn-theme').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  /* ---------------- auto-save and word wrap ---------------- */

  function applyAutosave(enabled) {
    storage.set('autosave', enabled);
    $('btn-autosave').setAttribute('aria-checked', String(enabled));
    NP.editor.setAutosave(enabled);
  }

  $('btn-autosave').addEventListener('click', () => {
    applyAutosave($('btn-autosave').getAttribute('aria-checked') !== 'true');
  });

  function applyWordWrap(enabled) {
    storage.set('wordwrap', enabled);
    $('fmt-wrap').setAttribute('aria-pressed', String(enabled));
    NP.editor.setWordWrap(enabled);
  }

  const toggleWordWrap = () => applyWordWrap($('fmt-wrap').getAttribute('aria-pressed') !== 'true');
  $('fmt-wrap').addEventListener('click', toggleWordWrap);

  /* ---------------- sidebar ---------------- */

  function setSidebarWidth(width, persist) {
    const value = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, Math.round(width)));
    document.documentElement.style.setProperty('--sidebar-width', `${value}px`);
    if (persist) storage.set('sidebarWidth', value);
    return value;
  }

  function setSidebarHidden(hidden) {
    appEl.classList.toggle('sidebar-hidden', hidden);
    storage.set('sidebarHidden', hidden);
  }

  const toggleSidebar = () => setSidebarHidden(!appEl.classList.contains('sidebar-hidden'));
  $('btn-toggle-sidebar').addEventListener('click', toggleSidebar);

  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('dragging');
    document.body.classList.add('resizing');
  });
  resizer.addEventListener('pointermove', (e) => {
    if (resizer.hasPointerCapture(e.pointerId)) setSidebarWidth(e.clientX - sidebar.getBoundingClientRect().left, false);
  });
  const endDrag = (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    resizer.releasePointerCapture(e.pointerId);
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    setSidebarWidth(sidebar.getBoundingClientRect().width, true);
  };
  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);
  resizer.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setSidebarWidth(sidebar.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? -16 : 16), true);
  });

  /* ---------------- actions ---------------- */

  const newFileAction = () => (NP.explorer.hasWorkspace() ? NP.explorer.startCreate('file') : NP.editor.newUntitled());

  $('btn-open-folder').addEventListener('click', NP.explorer.openDialog);
  $('btn-open-folder-empty').addEventListener('click', NP.explorer.openDialog);
  $('btn-empty-open').addEventListener('click', NP.explorer.openDialog);
  $('btn-new-file').addEventListener('click', () => NP.explorer.startCreate('file'));
  $('btn-new-folder').addEventListener('click', () => NP.explorer.startCreate('dir'));
  $('btn-refresh').addEventListener('click', NP.explorer.refresh);
  $('btn-search-workspace').addEventListener('click', () => NP.find.open('ws'));
  $('btn-new-tab').addEventListener('click', NP.editor.newUntitled);
  $('btn-empty-new').addEventListener('click', NP.editor.newUntitled);
  $('btn-save').addEventListener('click', NP.editor.saveActive);

  /* ---------------- keyboard shortcuts ---------------- */

  for (const key of document.querySelectorAll('[data-accel]')) key.textContent = NP.isMac ? '⌘' : 'Ctrl';

  const editorFocused = () => Boolean(document.activeElement && document.activeElement.classList.contains('editor'));

  document.addEventListener('keydown', (e) => {
    if (NP.dialog.isOpen()) return;

    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      NP.editor.switchTab(e.shiftKey ? -1 : 1);
      return;
    }

    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyZ') {
      e.preventDefault();
      toggleWordWrap();
      return;
    }

    const accel = NP.isMac ? e.metaKey : e.ctrlKey;
    if (accel && !e.altKey) {
      const key = e.key.toLowerCase();
      let action = null;
      if (!e.shiftKey) {
        action = {
          s: NP.editor.saveActive,
          n: newFileAction,
          w: NP.editor.closeActive,
          f: () => NP.find.open('doc'),
          o: NP.explorer.openDialog,
          '\\': toggleSidebar,
          b: editorFocused() ? NP.format.bold : null,
          i: editorFocused() ? NP.format.italic : null
        }[key];
      } else {
        action = {
          f: () => NP.find.open('ws'),
          x: editorFocused() ? NP.format.strike : null
        }[key];
      }
      if (action) {
        e.preventDefault();
        action();
        return;
      }
    }

    if (e.key === 'Escape' && NP.find.isOpen() && e.target.closest && e.target.closest('#find-panel, .editor')) {
      e.preventDefault();
      NP.find.close();
    }
  }, true);

  /* ---------------- window integration ---------------- */

  let closing = false;
  NP.api.onBeforeClose(async () => {
    if (closing) return;
    closing = true;
    try {
      if (await NP.editor.confirmAppClose()) await NP.api.confirmClose();
    } finally {
      closing = false;
    }
  });

  // Re-sync with the disk when the window regains focus, but not more often than every few seconds.
  let lastSync = 0;
  window.addEventListener('focus', () => {
    const now = Date.now();
    if (now - lastSync < FOCUS_SYNC_MIN_MS) return;
    lastSync = now;
    NP.explorer.refresh();
    NP.editor.checkExternalChanges();
  });

  /* ---------------- dropping files and folders from the OS ---------------- */

  const overlay = $('drop-overlay');
  let dragDepth = 0;
  const hasFiles = (e) => Boolean(e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files'));
  const hideOverlay = () => {
    dragDepth = 0;
    overlay.hidden = true;
  };

  async function handleExternalDrop(files) {
    try {
      const result = await NP.api.handleDrop(files);
      if (result.workspace) await NP.explorer.setRoot(result.workspace);
      for (const file of result.files) await NP.editor.openFile(file.path);
      const notes = [];
      if (result.skipped) notes.push(`${result.skipped} unsupported item${result.skipped === 1 ? '' : 's'} skipped (only .txt and .md files and folders are accepted)`);
      if (result.extraFolders) notes.push('only the first folder was opened as the workspace');
      if (result.errors.length) notes.push(result.errors[0]);
      if (notes.length) NP.notify(`Drop: ${notes.join('; ')}.`, result.errors.length && !result.workspace && !result.files.length ? 'error' : 'info');
      else if (result.workspace) NP.notify(`Opened folder "${result.workspace.name}".`);
    } catch (err) {
      NP.notify(err.message, 'error');
    }
  }

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hideOverlay();
    handleExternalDrop(Array.from(e.dataTransfer.files));
  });
  window.addEventListener('dragend', hideOverlay);

  /* ---------------- startup ---------------- */

  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const savedWidth = parseInt(storage.get('sidebarWidth', '260'), 10);
  setSidebarWidth(Number.isFinite(savedWidth) ? savedWidth : 260, false);
  setSidebarHidden(storage.get('sidebarHidden', 'false') === 'true');
  applyAutosave(storage.get('autosave', 'true') !== 'false');
  applyWordWrap(storage.get('wordwrap', 'false') === 'true');
  NP.explorer.restore();
})();
