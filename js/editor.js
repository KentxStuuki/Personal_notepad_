(function () {
  'use strict';

  const NP = window.NP;
  const { api, el, icons, baseName, isUnder, notify, countText } = NP;
  const $ = (id) => document.getElementById(id);

  const tabsEl = $('tabs');
  const hostEl = $('editor-host');
  const emptyEl = $('empty-state');
  const saveBtn = $('btn-save');

  const AUTOSAVE_DELAY_MS = 1200;
  const LARGE_DOC_CHARS = 300000;
  const docs = [];
  let active = null;
  let nextId = 1;
  let untitledCount = 0;
  let autosaveEnabled = true;

  /* ---------------- saved-state tracking ---------------- */
  // Only the length and a 53-bit hash of the saved text are kept, never a second copy of the document.

  function hashText(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function setSaved(doc, text) {
    doc.savedLen = text.length;
    doc.savedHash = hashText(text);
    doc.lenHint = text.length;
  }

  /** Exact check against the saved baseline. Reads the whole text, so it is used only at decision points. */
  function isModified(doc) {
    if (doc.orphaned) return true;
    const value = doc.el.value;
    return value.length !== doc.savedLen || hashText(value) !== doc.savedHash;
  }

  const iconFor = (d) => (/\.md$/i.test(d.name) ? icons.markdown : icons.text);

  /* ---------------- documents ---------------- */

  function createDoc({ path = null, name, content = '', mtime = null, bom = false, eol = 'LF', orphaned = false }) {
    const ta = el('textarea', {
      class: 'editor',
      spellcheck: 'false',
      autocomplete: 'off',
      autocapitalize: 'off',
      'aria-label': name,
      hidden: true
    });
    ta.value = content;

    const doc = {
      id: nextId++, path, name, el: ta, mtime, bom, eol,
      savedLen: 0, savedHash: 0, lenHint: 0,
      modified: orphaned, orphaned, queue: null, saving: false, error: false,
      conflict: false, missing: false, timer: null, savedAt: null, closing: false, closed: false, fmtNotice: false
    };
    setSaved(doc, content);

    ta.addEventListener('input', () => onInput(doc));
    ta.addEventListener('keyup', scheduleCursor);
    ta.addEventListener('mouseup', scheduleCursor);
    ta.addEventListener('focus', scheduleCursor);
    ta.addEventListener('select', scheduleCursor);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '\t');
      }
    });

    hostEl.append(ta);
    docs.push(doc);
    return doc;
  }

  /** Per-keystroke work is O(1): the exact comparison and the counters run once typing pauses. */
  function onInput(doc) {
    doc.error = false;
    if (!doc.modified) {
      doc.modified = true;
      refreshTab(doc);
    }
    if (doc === active) renderSaveStatus();
    scheduleAutosave(doc);
    scheduleIdle(doc);
  }

  let idleTimer = 0;
  let idleDoc = null;

  function scheduleIdle(doc) {
    idleDoc = doc;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(runIdle, doc.lenHint > LARGE_DOC_CHARS ? 700 : 250);
  }

  function runIdle() {
    const doc = idleDoc;
    idleDoc = null;
    if (!doc || doc.closed) return;
    const value = doc.el.value;
    doc.lenHint = value.length;
    const modified = doc.orphaned || value.length !== doc.savedLen || hashText(value) !== doc.savedHash;
    if (modified !== doc.modified) {
      doc.modified = modified;
      refreshTab(doc);
      if (!modified) clearTimeout(doc.timer);
    }
    if (doc === active) {
      renderSaveStatus();
      renderCounts(value);
      NP.find.onDocChanged();
      NP.preview.update();
    }
  }

  async function openFile(path) {
    const existing = docs.find((d) => d.path === path);
    if (existing) {
      activate(existing);
      return existing;
    }
    try {
      const file = await api.readFile(path);
      const again = docs.find((d) => d.path === file.path);
      if (again) {
        activate(again);
        return again;
      }
      const doc = createDoc({
        path: file.path, name: baseName(file.path), content: file.content,
        mtime: file.mtime, bom: file.bom, eol: file.eol
      });
      activate(doc);
      return doc;
    } catch (err) {
      notify(err.message, 'error');
      await NP.dialog.alert('Cannot open file', err.message);
      return null;
    }
  }

  function newUntitled() {
    untitledCount++;
    const doc = createDoc({ name: `Untitled-${untitledCount}.txt` });
    activate(doc);
    return doc;
  }

  function activate(doc) {
    active = doc;
    for (const d of docs) d.el.hidden = d !== doc;
    emptyEl.hidden = Boolean(doc);
    renderTabs();
    renderStatus();
    NP.explorer.highlight();
    NP.find.refresh();
    NP.format.refresh();
    NP.preview.update();
    if (doc) doc.el.focus();
  }

  function removeDoc(doc) {
    clearTimeout(doc.timer);
    doc.closed = true;
    doc.queue = null;
    if (idleDoc === doc) idleDoc = null;
    const index = docs.indexOf(doc);
    docs.splice(index, 1);
    doc.el.remove();
    if (active === doc) activate(docs[index] || docs[index - 1] || null);
    else renderTabs();
  }

  async function closeDoc(doc) {
    if (!doc || doc.closing) return false;
    doc.closing = true;
    try {
      if (isModified(doc)) {
        activate(doc);
        const choice = await NP.dialog.show({
          title: 'Unsaved changes',
          message: `Do you want to save the changes to "${doc.name}"?`,
          detail: 'Your changes will be lost if you do not save them.',
          buttons: [
            { label: 'Save', value: 'save', primary: true },
            { label: "Don't Save", value: 'discard', danger: true },
            { label: 'Cancel', value: 'cancel' }
          ],
          cancelValue: 'cancel'
        });
        if (choice === 'cancel') return false;
        if (choice === 'save' && !(await saveDoc(doc))) return false;
      }
      removeDoc(doc);
      return true;
    } finally {
      doc.closing = false;
    }
  }

  function switchTab(direction) {
    if (docs.length < 2) return;
    const index = docs.indexOf(active);
    activate(docs[(index + direction + docs.length) % docs.length]);
  }

  /* ---------------- saving ---------------- */

  function saveDoc(doc, options = {}) {
    const run = () => performSave(doc, options);
    doc.queue = (doc.queue || Promise.resolve()).then(run, run);
    return doc.queue;
  }

  function setSaving(doc, value) {
    doc.saving = value;
    if (doc === active) renderSaveStatus();
  }

  async function assignPath(doc) {
    const result = await api.saveFileDialog(doc.name);
    if (!result) return false;
    if (docs.some((d) => d !== doc && d.path === result.path)) {
      await NP.dialog.alert('Cannot save', 'That file is already open in another tab.');
      return false;
    }
    doc.path = result.path;
    doc.name = baseName(result.path);
    doc.mtime = null;
    refreshTab(doc);
    return true;
  }

  async function performSave(doc, { auto = false, force = false } = {}) {
    if (doc.closed) return false;
    clearTimeout(doc.timer);
    let newlyAssigned = false;

    if (!doc.path) {
      if (auto) return false;
      if (!(await assignPath(doc))) return false;
      newlyAssigned = true;
    } else if (!force && !isModified(doc)) {
      if (doc.modified) {
        doc.modified = false;
        refreshTab(doc);
        if (doc === active) renderSaveStatus();
      }
      return true;
    }

    const text = doc.el.value;
    setSaving(doc, true);
    try {
      const result = await api.writeFile({
        path: doc.path, content: text, bom: doc.bom, eol: doc.eol, expectedMtime: doc.mtime, force
      });
      if (result.conflict) {
        doc.conflict = true;
        setSaving(doc, false);
        if (auto) return false;
        const choice = await NP.dialog.show({
          title: 'File changed on disk',
          message: `"${doc.name}" was modified outside ${document.title || 'the app'} since it was opened.`,
          detail: 'Overwriting will discard the changes made outside this app.',
          buttons: [
            { label: 'Overwrite', value: 'overwrite', danger: true },
            { label: 'Cancel', value: 'cancel', primary: true }
          ],
          cancelValue: 'cancel'
        });
        return choice === 'overwrite' ? performSave(doc, { auto, force: true }) : false;
      }
      setSaved(doc, text);
      doc.mtime = result.mtime;
      doc.orphaned = false;
      doc.conflict = false;
      doc.missing = false;
      doc.error = false;
      doc.savedAt = new Date();
      doc.modified = isModified(doc);
      setSaving(doc, false);
      refreshTab(doc);
      if (doc === active) renderStatus();
      if (newlyAssigned) NP.explorer.refresh();
      NP.find.markStale();
      if (doc.modified) scheduleAutosave(doc);
      return true;
    } catch (err) {
      doc.error = true;
      setSaving(doc, false);
      refreshTab(doc);
      notify(`Could not save "${doc.name}": ${err.message}`, 'error');
      if (!auto) await NP.dialog.alert('Save failed', err.message);
      return false;
    }
  }

  function scheduleAutosave(doc) {
    clearTimeout(doc.timer);
    if (!autosaveEnabled || !doc.path || !doc.modified) return;
    doc.timer = setTimeout(() => saveDoc(doc, { auto: true }), AUTOSAVE_DELAY_MS);
  }

  function setAutosave(enabled) {
    autosaveEnabled = enabled;
    $('stat-autosave').textContent = `Auto-save: ${enabled ? 'On' : 'Off'}`;
    for (const d of docs) {
      if (enabled) scheduleAutosave(d);
      else clearTimeout(d.timer);
    }
    renderSaveStatus();
  }

  async function confirmAppClose() {
    const dirty = docs.filter(isModified);
    if (dirty.length === 0) return true;
    const choice = await NP.dialog.show({
      title: 'Unsaved changes',
      message: dirty.length === 1
        ? `"${dirty[0].name}" has unsaved changes.`
        : `${dirty.length} files have unsaved changes.`,
      detail: 'Save your changes before closing?',
      buttons: [
        { label: 'Save All', value: 'save', primary: true },
        { label: 'Discard', value: 'discard', danger: true },
        { label: 'Cancel', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    });
    if (choice === 'cancel') return false;
    if (choice === 'discard') return true;
    for (const d of dirty) {
      if (!(await saveDoc(d))) return false;
    }
    return true;
  }

  /* ---------------- external changes and explorer sync ---------------- */

  async function reloadDoc(doc) {
    const before = doc.el.value;
    const file = await api.readFile(doc.path);
    if (doc.closed || doc.el.value !== before) {
      doc.conflict = true;
      return;
    }
    const caret = Math.min(doc.el.selectionStart, file.content.length);
    doc.el.value = file.content;
    doc.el.setSelectionRange(caret, caret);
    setSaved(doc, file.content);
    doc.mtime = file.mtime;
    doc.bom = file.bom;
    doc.eol = file.eol;
    doc.modified = false;
    doc.conflict = false;
    notify(`Reloaded "${doc.name}" (changed on disk).`);
  }

  async function checkExternalChanges() {
    for (const doc of [...docs]) {
      if (!doc.path || doc.saving || doc.closing) continue;
      try {
        const st = await api.statFile(doc.path);
        if (doc.closed || doc.saving) continue;
        if (!st.exists) {
          doc.missing = true;
        } else {
          doc.missing = false;
          if (st.mtime !== doc.mtime) {
            if (isModified(doc)) doc.conflict = true;
            else await reloadDoc(doc);
          }
        }
        refreshTab(doc);
      } catch {
        /* inaccessible file: leave state unchanged */
      }
    }
    if (active) renderStatus();
  }

  function handleRenamed(oldPath, newPath) {
    for (const d of docs) {
      if (d.path && isUnder(d.path, oldPath)) {
        d.path = newPath + d.path.slice(oldPath.length);
        d.name = baseName(d.path);
        d.el.setAttribute('aria-label', d.name);
        refreshTab(d);
      }
    }
    if (active) renderStatus();
  }

  /** Documents whose file was deleted keep their content as unsaved, path-less documents. */
  function handleDeleted(path) {
    for (const d of docs) {
      if (d.path && isUnder(d.path, path)) {
        clearTimeout(d.timer);
        d.path = null;
        d.mtime = null;
        d.orphaned = true;
        d.modified = true;
        d.conflict = false;
        d.missing = false;
        refreshTab(d);
      }
    }
    NP.explorer.highlight();
    if (active) renderStatus();
  }

  /* ---------------- tabs ---------------- */

  function tabEl(doc) {
    return el(
      'div',
      {
        class: 'tab' + (doc === active ? ' active' : '') + (doc.modified ? ' modified' : ''),
        role: 'tab',
        'aria-selected': String(doc === active),
        title: doc.path || `${doc.name} (not saved)`,
        dataset: { id: String(doc.id) }
      },
      el('span', { class: 'tab-icon', html: iconFor(doc) }),
      el('span', { class: 'tab-name', text: doc.name }),
      el('span', { class: 'tab-dot', text: '•', 'aria-label': 'Unsaved changes' }),
      el('button', { class: 'tab-close', type: 'button', title: 'Close (Ctrl+W)', 'aria-label': `Close ${doc.name}`, text: '×' })
    );
  }

  function renderTabs() {
    const frag = document.createDocumentFragment();
    for (const d of docs) frag.append(tabEl(d));
    tabsEl.replaceChildren(frag);
    const current = tabsEl.querySelector('.tab.active');
    if (current) current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function refreshTab(doc) {
    const tab = tabsEl.querySelector(`[data-id="${doc.id}"]`);
    if (!tab) return;
    tab.classList.toggle('modified', doc.modified);
    tab.title = doc.path || `${doc.name} (not saved)`;
    tab.querySelector('.tab-name').textContent = doc.name;
    tab.querySelector('.tab-icon').innerHTML = iconFor(doc);
  }

  tabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const doc = docs.find((d) => String(d.id) === tab.dataset.id);
    if (!doc) return;
    if (e.target.closest('.tab-close')) closeDoc(doc);
    else activate(doc);
  });
  tabsEl.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const tab = e.target.closest('.tab');
    const doc = tab && docs.find((d) => String(d.id) === tab.dataset.id);
    if (doc) {
      e.preventDefault();
      closeDoc(doc);
    }
  });
  tabsEl.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      tabsEl.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  // Keeps the match-highlight layer and the Markdown preview in step with the visible textarea.
  hostEl.addEventListener('scroll', (e) => {
    if (active && e.target === active.el) {
      NP.find.syncScroll();
      NP.preview.syncScroll();
    }
  }, true);

  /* ---------------- status bar ---------------- */

  function saveStatus(doc) {
    if (doc.saving) return 'Saving…';
    if (doc.conflict) return 'Changed on disk';
    if (doc.error) return 'Save failed';
    if (doc.missing) return 'File missing on disk';
    if (doc.modified) return 'Unsaved changes';
    if (doc.savedAt) return `Saved ${doc.savedAt.toLocaleTimeString()}`;
    return doc.path ? 'Saved' : 'New file';
  }

  function renderSaveStatus() {
    const node = $('stat-save');
    saveBtn.disabled = !active;
    if (!active) {
      node.textContent = '';
      return;
    }
    node.textContent = saveStatus(active);
    node.dataset.state = active.saving ? 'saving' : active.conflict || active.error || active.missing ? 'error' : active.modified ? 'dirty' : 'saved';
  }

  function renderCounts(value) {
    if (!active) {
      $('stat-words').textContent = 'Words: –';
      $('stat-chars').textContent = 'Chars: –';
      return;
    }
    const { words, chars } = countText(value === undefined ? active.el.value : value);
    $('stat-words').textContent = `Words: ${words.toLocaleString()}`;
    $('stat-chars').textContent = `Chars: ${chars.toLocaleString()}`;
  }

  function renderCursor() {
    const node = $('stat-pos');
    if (!active) {
      node.textContent = '';
      return;
    }
    const ta = active.el;
    const text = ta.value;
    const pos = ta.selectionStart;
    let line = 1;
    let lineStart = 0;
    if (pos > 0) {
      for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) line++;
      lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    }
    const selected = ta.selectionEnd - pos;
    node.textContent = `Ln ${line}, Col ${pos - lineStart + 1}` + (selected ? ` (${selected} selected)` : '');
    NP.format.onCursorChange(text);
  }

  function renderStatus() {
    renderSaveStatus();
    renderCounts();
    renderCursor();
    $('stat-enc').textContent = active ? `UTF-8${active.bom ? ' BOM' : ''} · ${active.eol}` : '';
  }

  let cursorTimer = 0;
  function scheduleCursor() {
    if (cursorTimer) return;
    const fire = () => {
      cursorTimer = 0;
      renderCursor();
    };
    cursorTimer = active && active.lenHint > LARGE_DOC_CHARS ? setTimeout(fire, 150) : requestAnimationFrame(fire);
  }

  /* ---------------- view helpers ---------------- */

  function setWordWrap(enabled) {
    hostEl.classList.toggle('wrap', enabled);
    NP.find.onDocChanged();
  }

  let measureCtx = null;
  function metrics(ta) {
    const cs = getComputedStyle(ta);
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return {
      lineHeight: parseFloat(cs.lineHeight) || 20,
      charWidth: measureCtx.measureText('0'.repeat(50)).width / 50,
      padTop: parseFloat(cs.paddingTop) || 0,
      padLeft: parseFloat(cs.paddingLeft) || 0,
      tabSize: parseInt(cs.tabSize, 10) || 4
    };
  }

  /** Scrolls a textarea so the range is visible (selecting alone does not scroll an unfocused textarea). */
  function revealRange(ta, index, length) {
    const text = ta.value;
    const m = metrics(ta);
    const wrap = hostEl.classList.contains('wrap');
    let line = 0;
    for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
    const lineStart = index === 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1;
    const before = text.slice(lineStart, index);
    const tabs = (before.match(/\t/g) || []).length;
    const column = before.length + tabs * (m.tabSize - 1);

    // With wrapping, long lines occupy several visual rows, so measure the real scroll height instead.
    let top = m.padTop + line * m.lineHeight;
    if (wrap) {
      const ratio = text.length ? index / text.length : 0;
      top = Math.max(top, ratio * ta.scrollHeight - m.lineHeight * 2);
      if (line === 0) top = m.padTop;
    }
    if (top < ta.scrollTop || top + m.lineHeight > ta.scrollTop + ta.clientHeight) {
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 2);
    }
    if (!wrap) {
      const left = m.padLeft + column * m.charWidth;
      if (left < ta.scrollLeft || left + length * m.charWidth > ta.scrollLeft + ta.clientWidth) {
        ta.scrollLeft = Math.max(0, left - ta.clientWidth / 3);
      }
    }
  }

  function goTo(doc, index, length, { focus = true } = {}) {
    if (!doc || doc.closed) return;
    const ta = doc.el;
    if (focus) ta.focus();
    ta.setSelectionRange(index, index + length);
    revealRange(ta, index, length);
    renderCursor();
  }

  NP.editor = {
    openFile,
    newUntitled,
    activeDoc: () => active,
    activePath: () => (active ? active.path : null),
    hasDocs: () => docs.length > 0,
    saveActive: () => (active ? saveDoc(active) : Promise.resolve(false)),
    closeActive: () => closeDoc(active),
    switchTab,
    setAutosave,
    setWordWrap,
    focus: () => active && active.el.focus(),
    updateCursor: renderCursor,
    revealRange,
    goTo,
    handleRenamed,
    handleDeleted,
    checkExternalChanges,
    confirmAppClose
  };
})();
