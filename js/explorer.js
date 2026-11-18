(function () {
  'use strict';

  const NP = window.NP;
  const { api, el, icons, baseName, parentOf, isUnder, notify } = NP;
  const $ = (id) => document.getElementById(id);

  const CHUNK = 500; // rows rendered per folder before "Show more"
  const treeEl = $('tree');
  const emptyEl = $('tree-empty');
  const nameEl = $('workspace-name');
  const controls = ['btn-new-file', 'btn-new-folder', 'btn-refresh', 'btn-search-workspace'].map($);

  let root = null; // { path, name }
  const children = new Map(); // dir path -> entries (loaded lazily, only for folders that were expanded)
  const expanded = new Set();
  const shown = new Map(); // dir path -> number of rows currently rendered
  let selected = null; // { path, type }
  let pending = null; // inline input state: { mode, type, parent?, path?, value?, busy }
  let suppressBlur = false;
  let menuEl = null;
  let dragState = null; // { path, type } while an explorer item is dragged
  let lastMark = '';
  let hoverTimer = 0;
  let hoverKey = '';

  const sig = (list) => list.map((e) => `${e.name}|${e.type}|${e.supported ? 1 : 0}`).join('\n');
  const rowFor = (path) => treeEl.querySelector(`[data-path="${CSS.escape(path)}"]`);

  const iconFor = (entry, open) =>
    entry.type === 'dir'
      ? open ? icons.folderOpen : icons.folder
      : !entry.supported ? icons.file : /\.md$/i.test(entry.name) ? icons.markdown : icons.text;

  /* ---------------- workspace ---------------- */

  async function setRoot(info) {
    root = info;
    children.clear();
    expanded.clear();
    shown.clear();
    expanded.add(info.path);
    selected = null;
    pending = null;
    await loadDir(info.path);
    fullRender();
    NP.find.reset();
  }

  async function openDialog() {
    try {
      const info = await api.openWorkspace();
      if (info) await setRoot(info);
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function restore() {
    try {
      const info = await api.restoreWorkspace();
      if (info) await setRoot(info);
    } catch {
      /* no previous workspace */
    }
    fullRender();
  }

  /** Loads one folder. Resolves to true when the listing changed, false when identical, 'error' on failure. */
  async function loadDir(dir) {
    try {
      const list = await api.readDir(dir);
      const previous = children.get(dir);
      children.set(dir, list);
      return !previous || sig(previous) !== sig(list);
    } catch {
      children.delete(dir);
      expanded.delete(dir);
      return 'error';
    }
  }

  async function refreshDir(dir, { force = false } = {}) {
    if (!root) return;
    const result = await loadDir(dir);
    if (result === 'error') {
      if (dir === root.path) {
        notify('The workspace folder is no longer accessible.', 'error');
        fullRender();
      } else {
        await refreshDir(parentOf(dir), { force: true });
      }
      return;
    }
    if (result || force) rerenderDir(dir);
  }

  /** Re-reads every expanded folder, re-rendering only the ones whose contents changed. */
  async function refresh() {
    if (!root) return;
    await Promise.all([...expanded].map((dir) => refreshDir(dir)));
    if (selected) {
      const list = children.get(parentOf(selected.path));
      if (!list || !list.some((e) => e.path === selected.path)) selected = null;
    }
    highlight();
  }

  /* ---------------- rendering ---------------- */

  function updateControls() {
    for (const btn of controls) btn.disabled = !root;
  }

  function captureInputValue() {
    const live = treeEl.querySelector('.tree-input');
    if (live && pending) pending.value = live.value;
  }

  function fullRender() {
    updateControls();
    emptyEl.hidden = Boolean(root);
    treeEl.hidden = !root;
    nameEl.textContent = root ? root.name : 'No folder open';
    nameEl.title = root ? root.path : '';
    if (!root) {
      treeEl.replaceChildren();
      return;
    }
    captureInputValue();
    const frag = document.createDocumentFragment();
    buildRows(root.path, 0, frag);
    if (!frag.childNodes.length) {
      frag.append(el('div', { class: 'empty-note', text: 'This folder is empty. Use the buttons above to create a file or folder.' }));
    }
    suppressBlur = true;
    treeEl.replaceChildren(frag);
    suppressBlur = false;
    highlight();
    focusPendingInput();
  }

  /** Replaces only the rows that belong to one folder, leaving the rest of the tree untouched. */
  function rerenderDir(dir) {
    if (!root) return;
    if (dir === root.path) {
      fullRender();
      return;
    }
    const row = rowFor(dir);
    if (!row) return;
    const depth = Number(row.dataset.depth);
    captureInputValue();
    suppressBlur = true;
    for (let n = row.nextElementSibling; n && Number(n.dataset.depth) > depth; n = row.nextElementSibling) n.remove();
    const open = expanded.has(dir);
    row.classList.toggle('open', open);
    row.setAttribute('aria-expanded', String(open));
    row.querySelector('.tree-chevron').classList.toggle('open', open);
    row.querySelector('.tree-icon').innerHTML = open ? icons.folderOpen : icons.folder;
    if (open) {
      const frag = document.createDocumentFragment();
      buildRows(dir, depth + 1, frag);
      row.after(frag);
    }
    suppressBlur = false;
    highlight();
    focusPendingInput();
  }

  function buildRows(dir, depth, frag) {
    if (pending && pending.mode === 'create' && pending.parent === dir) {
      frag.append(inputRow(depth, pending.type, ''));
    }
    const list = children.get(dir) || [];
    const limit = shown.get(dir) || CHUNK;
    const count = Math.min(list.length, limit);
    for (let i = 0; i < count; i++) {
      const entry = list[i];
      if (pending && pending.mode === 'rename' && pending.path === entry.path) {
        frag.append(inputRow(depth, entry.type, entry.name));
      } else {
        frag.append(entryRow(entry, depth));
      }
      if (entry.type === 'dir' && expanded.has(entry.path)) buildRows(entry.path, depth + 1, frag);
    }
    if (list.length > count) frag.append(moreRow(dir, depth, list.length - count));
  }

  function entryRow(entry, depth) {
    const isDir = entry.type === 'dir';
    const open = isDir && expanded.has(entry.path);
    const movable = isDir || entry.supported;
    const row = el(
      'div',
      {
        class: 'tree-row' + (!isDir && !entry.supported ? ' unsupported' : ''),
        role: 'treeitem',
        'aria-expanded': isDir ? String(open) : null,
        draggable: movable ? 'true' : null,
        title: !isDir && !entry.supported ? `${entry.path} (unsupported file type)` : entry.path,
        dataset: { path: entry.path, type: entry.type, supported: String(Boolean(entry.supported)), depth: String(depth) }
      },
      el('span', { class: 'tree-chevron' + (open ? ' open' : ''), html: isDir ? icons.chevron : '' }),
      el('span', { class: 'tree-icon' + (isDir ? ' folder' : ''), html: iconFor(entry, open) }),
      el('span', { class: 'tree-label', text: entry.name })
    );
    row.style.paddingLeft = `${8 + depth * 14}px`;
    return row;
  }

  function moreRow(dir, depth, hidden) {
    const row = el('div', {
      class: 'tree-row tree-more',
      role: 'button',
      dataset: { more: dir, depth: String(depth) },
      text: `Show ${Math.min(hidden, CHUNK)} more… (${hidden} hidden)`
    });
    row.style.paddingLeft = `${8 + depth * 14 + 20}px`;
    return row;
  }

  function inputRow(depth, type, value) {
    const input = el('input', {
      class: 'tree-input',
      type: 'text',
      spellcheck: 'false',
      maxlength: '200',
      'aria-label': type === 'dir' ? 'Folder name' : 'File name'
    });
    input.value = pending && pending.value !== undefined ? pending.value : value;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        submitPending(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelPending();
      }
    });
    input.addEventListener('input', () => input.classList.remove('invalid'));
    input.addEventListener('blur', () => {
      if (suppressBlur || !pending || pending.busy || !document.hasFocus()) return;
      cancelPending();
    });
    const row = el(
      'div',
      { class: 'tree-row editing', dataset: { depth: String(depth) } },
      el('span', { class: 'tree-chevron' }),
      el('span', { class: 'tree-icon' + (type === 'dir' ? ' folder' : ''), html: type === 'dir' ? icons.folder : icons.text }),
      input
    );
    row.style.paddingLeft = `${8 + depth * 14}px`;
    return row;
  }

  function focusPendingInput() {
    const input = treeEl.querySelector('.tree-input');
    if (!input || document.activeElement === input) return;
    input.focus();
    if (pending && pending.value === undefined) {
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, pending.mode === 'rename' && pending.type === 'file' && dot > 0 ? dot : input.value.length);
    }
    if (pending) pending.value = input.value;
  }

  function highlight() {
    const activePath = NP.editor.activePath();
    for (const node of treeEl.querySelectorAll('.tree-row.selected, .tree-row.active')) {
      if (!selected || node.dataset.path !== selected.path) node.classList.remove('selected');
      if (node.dataset.path !== activePath) node.classList.remove('active');
    }
    if (selected) {
      const row = rowFor(selected.path);
      if (row) row.classList.add('selected');
    }
    if (activePath) {
      const row = rowFor(activePath);
      if (row) row.classList.add('active');
    }
  }

  /* ---------------- create / rename / delete ---------------- */

  function defaultParent() {
    if (!selected) return root.path;
    return selected.type === 'dir' ? selected.path : parentOf(selected.path);
  }

  async function startCreate(type, forcedParent) {
    if (!root) return;
    const parent = forcedParent || defaultParent();
    expanded.add(parent);
    if (!children.has(parent)) await loadDir(parent);
    pending = { mode: 'create', type, parent, busy: false };
    rerenderDir(parent);
  }

  function startRename(path, type) {
    if (!root || !path) return;
    pending = { mode: 'rename', type, path, busy: false };
    rerenderDir(parentOf(path));
  }

  function cancelPending() {
    if (!pending) return;
    const job = pending;
    pending = null;
    rerenderDir(job.mode === 'create' ? job.parent : parentOf(job.path));
  }

  function remapPaths(oldPath, newPath) {
    for (const p of [...expanded]) {
      if (isUnder(p, oldPath)) {
        expanded.delete(p);
        expanded.add(newPath + p.slice(oldPath.length));
      }
    }
    for (const key of [...children.keys()]) if (isUnder(key, oldPath)) children.delete(key);
    for (const key of [...shown.keys()]) if (isUnder(key, oldPath)) shown.delete(key);
    if (selected && isUnder(selected.path, oldPath)) selected.path = newPath + selected.path.slice(oldPath.length);
  }

  /** After a folder was renamed or moved, listings of expanded folders inside it must be re-read under the new path. */
  async function reloadExpandedUnder(path) {
    await Promise.all([...expanded].filter((p) => isUnder(p, path) && p !== path).map(loadDir));
  }

  async function submitPending(raw) {
    if (!pending || pending.busy) return;
    const job = pending;
    const name = raw.trim();
    if (!name) {
      cancelPending();
      return;
    }
    job.busy = true;

    let result;
    try {
      if (job.mode === 'create') {
        result = job.type === 'dir' ? await api.createFolder(job.parent, name) : await api.createFile(job.parent, name);
      } else {
        result = await api.renameEntry(job.path, name);
      }
    } catch (err) {
      job.busy = false;
      notify(err.message, 'error');
      const input = treeEl.querySelector('.tree-input');
      if (input) {
        input.classList.add('invalid');
        input.focus();
      }
      return;
    }

    pending = null;
    NP.find.markStale();
    if (job.mode === 'create') {
      expanded.add(job.parent);
      if (job.type === 'dir') expanded.add(result.path);
      selected = { path: result.path, type: job.type };
      if (job.type === 'dir') await loadDir(result.path);
      await refreshDir(job.parent, { force: true });
      if (job.type === 'file') await NP.editor.openFile(result.path);
    } else {
      if (result.path !== job.path) {
        remapPaths(job.path, result.path);
        NP.editor.handleRenamed(job.path, result.path);
        await reloadExpandedUnder(result.path);
      }
      await refreshDir(parentOf(job.path), { force: true });
    }
  }

  async function deleteEntry(path) {
    try {
      const result = await api.deleteEntry(path);
      if (!result.deleted) return;
      for (const p of [...expanded]) if (isUnder(p, path)) expanded.delete(p);
      for (const key of [...children.keys()]) if (isUnder(key, path)) children.delete(key);
      if (selected && isUnder(selected.path, path)) selected = null;
      NP.editor.handleDeleted(path);
      NP.find.markStale();
      await refreshDir(parentOf(path), { force: true });
    } catch (err) {
      notify(err.message, 'error');
      await NP.dialog.alert('Cannot delete', err.message);
    }
  }

  async function toggleDir(path) {
    if (expanded.has(path)) {
      expanded.delete(path);
    } else {
      expanded.add(path);
      if (!children.has(path) && (await loadDir(path)) === 'error') {
        notify('This folder cannot be opened.', 'error');
        await refreshDir(parentOf(path), { force: true });
        return;
      }
    }
    rerenderDir(path);
  }

  /* ---------------- drag and drop (moving inside the workspace) ---------------- */

  function dropTarget(e) {
    const row = e.target.closest && e.target.closest('.tree-row[data-path]');
    if (!row) return root.path;
    return row.dataset.type === 'dir' ? row.dataset.path : parentOf(row.dataset.path);
  }

  const canDrop = (src, dir) => src.path !== dir && !isUnder(dir, src.path) && parentOf(src.path) !== dir;

  function clearMarks() {
    lastMark = '';
    clearTimeout(hoverTimer);
    hoverKey = '';
    treeEl.classList.remove('drop-root', 'drop-root-invalid');
    for (const node of treeEl.querySelectorAll('.drop-target, .drop-invalid')) node.classList.remove('drop-target', 'drop-invalid');
  }

  function markTarget(dir, valid) {
    const key = `${dir}|${valid}`;
    if (key === lastMark) return;
    clearMarks();
    lastMark = key;
    if (dir === root.path) {
      treeEl.classList.add(valid ? 'drop-root' : 'drop-root-invalid');
      return;
    }
    const row = rowFor(dir);
    if (row) row.classList.add(valid ? 'drop-target' : 'drop-invalid');
    if (valid && !expanded.has(dir) && hoverKey !== dir) {
      hoverKey = dir;
      hoverTimer = setTimeout(() => toggleDir(dir), 700);
    }
  }

  async function performMove(src, dir) {
    try {
      const result = await api.moveEntry(src.path, dir);
      if (result.unchanged) return;
      const oldParent = parentOf(src.path);
      remapPaths(src.path, result.path);
      NP.editor.handleRenamed(src.path, result.path);
      expanded.add(dir);
      if (!children.has(dir)) await loadDir(dir);
      await reloadExpandedUnder(result.path);
      selected = { path: result.path, type: src.type };
      NP.find.markStale();
      await refreshDir(oldParent, { force: true });
      await refreshDir(dir, { force: true });
      notify(`Moved "${baseName(result.path)}".`);
    } catch (err) {
      notify(err.message, 'error');
      await NP.dialog.alert('Cannot move', err.message);
    }
  }

  treeEl.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('.tree-row[data-path]');
    if (!row || pending || row.getAttribute('draggable') !== 'true') {
      e.preventDefault();
      return;
    }
    dragState = { path: row.dataset.path, type: row.dataset.type };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', baseName(dragState.path));
    row.classList.add('dragging');
  });

  treeEl.addEventListener('dragover', (e) => {
    if (!dragState || !root) return;
    const dir = dropTarget(e);
    const valid = canDrop(dragState, dir);
    if (valid) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    } else {
      e.dataTransfer.dropEffect = 'none';
    }
    markTarget(dir, valid);
  });

  treeEl.addEventListener('dragleave', (e) => {
    if (dragState && !treeEl.contains(e.relatedTarget)) clearMarks();
  });

  treeEl.addEventListener('drop', (e) => {
    if (!dragState || !root) return;
    e.preventDefault();
    const src = dragState;
    const dir = dropTarget(e);
    dragState = null;
    clearMarks();
    for (const node of treeEl.querySelectorAll('.dragging')) node.classList.remove('dragging');
    if (canDrop(src, dir)) performMove(src, dir);
  });

  treeEl.addEventListener('dragend', () => {
    dragState = null;
    clearMarks();
    for (const node of treeEl.querySelectorAll('.dragging')) node.classList.remove('dragging');
  });

  /* ---------------- tree interaction ---------------- */

  function rowInfo(row) {
    return { path: row.dataset.path, type: row.dataset.type, supported: row.dataset.supported === 'true' };
  }

  treeEl.addEventListener('click', async (e) => {
    const more = e.target.closest('.tree-more');
    if (more) {
      const dir = more.dataset.more;
      shown.set(dir, (shown.get(dir) || CHUNK) + CHUNK);
      rerenderDir(dir);
      return;
    }
    const row = e.target.closest('.tree-row[data-path]');
    if (!row || pending) return;
    const info = rowInfo(row);
    selected = { path: info.path, type: info.type };
    if (info.type === 'dir') {
      highlight();
      await toggleDir(info.path);
    } else {
      highlight();
      if (info.supported) await NP.editor.openFile(info.path);
      else notify('This file type is not supported by the editor. The file is left untouched.');
    }
  });

  treeEl.addEventListener('keydown', (e) => {
    if (e.target !== treeEl || !selected || pending) return;
    const row = rowFor(selected.path);
    if (!row || (selected.type === 'file' && row.dataset.supported !== 'true')) return;
    if (e.key === 'F2') {
      e.preventDefault();
      startRename(selected.path, selected.type);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      deleteEntry(selected.path);
    }
  });

  treeEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!root || pending) return;
    const row = e.target.closest('.tree-row[data-path]');
    if (!row) {
      showMenu(e.clientX, e.clientY, [
        { label: 'New File', run: () => startCreate('file', root.path) },
        { label: 'New Folder', run: () => startCreate('dir', root.path) }
      ]);
      return;
    }
    const info = rowInfo(row);
    selected = { path: info.path, type: info.type };
    highlight();
    if (info.type === 'dir') {
      showMenu(e.clientX, e.clientY, [
        { label: 'New File', run: () => startCreate('file', info.path) },
        { label: 'New Folder', run: () => startCreate('dir', info.path) },
        { separator: true },
        { label: 'Rename', run: () => startRename(info.path, 'dir') },
        { label: 'Delete', danger: true, run: () => deleteEntry(info.path) }
      ]);
    } else {
      showMenu(e.clientX, e.clientY, [
        { label: 'Open', disabled: !info.supported, run: () => NP.editor.openFile(info.path) },
        { separator: true },
        { label: 'Rename', disabled: !info.supported, run: () => startRename(info.path, 'file') },
        { label: 'Delete', danger: true, disabled: !info.supported, run: () => deleteEntry(info.path) }
      ]);
    }
  });

  /* ---------------- context menu ---------------- */

  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
  }

  function showMenu(x, y, items) {
    closeMenu();
    const menu = el('div', { class: 'context-menu', role: 'menu' });
    for (const item of items) {
      if (item.separator) {
        menu.append(el('div', { class: 'context-separator', role: 'separator' }));
        continue;
      }
      menu.append(
        el('button', {
          class: 'context-item' + (item.danger ? ' danger' : ''),
          type: 'button',
          role: 'menuitem',
          text: item.label,
          disabled: item.disabled,
          onclick: () => {
            closeMenu();
            item.run();
          }
        })
      );
    }
    document.body.append(menu);
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
    menuEl = menu;
    const first = menu.querySelector('.context-item:not(:disabled)');
    if (first) first.focus();
  }

  document.addEventListener('mousedown', (e) => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!menuEl) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeMenu();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...menuEl.querySelectorAll('.context-item:not(:disabled)')];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(i + step + items.length) % items.length].focus();
    }
  }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('wheel', closeMenu, { passive: true });

  NP.explorer = {
    openDialog,
    restore,
    refresh,
    setRoot,
    highlight,
    hasWorkspace: () => Boolean(root),
    startCreate: (type) => startCreate(type)
  };
})();
