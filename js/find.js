(function () {
  'use strict';

  const NP = window.NP;
  const { api, el, icons, notify, debounce } = NP;
  const $ = (id) => document.getElementById(id);

  const panel = $('find-panel');
  const input = $('find-input');
  const caseBtn = $('find-case');
  const countEl = $('find-count');
  const clearBtn = $('find-clear');
  const resultsEl = $('search-results');
  const scopeDoc = $('scope-doc');
  const scopeWs = $('scope-ws');
  const layer = $('hl-layer');

  const HIGHLIGHT_MAX_CHARS = 300000;
  const HIGHLIGHT_MAX_MARKS = 3000;

  let scope = 'doc';
  let caseSensitive = false;
  let current = null; // { id, index } of the match last selected by the panel

  // workspace search state
  let searchId = 0;
  let stale = true;
  let lastQuery = '';
  let lastCase = false;
  let ws = null; // { files, flat, occ, fileCount, selected, truncated, done, running, summaryEl, listEl }

  function buildPattern(query = input.value, cs = caseSensitive) {
    if (!query) return null;
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs ? 'g' : 'gi');
  }

  /* ---------------- current document ---------------- */

  function clearHighlights() {
    if (layer.firstChild) layer.textContent = '';
  }

  function positionLayer(ta) {
    layer.style.right = `${ta.offsetWidth - ta.clientWidth}px`;
    layer.style.bottom = `${ta.offsetHeight - ta.clientHeight}px`;
  }

  function syncScroll() {
    const doc = NP.editor.activeDoc();
    if (!doc || !layer.firstChild) return;
    layer.scrollTop = doc.el.scrollTop;
    layer.scrollLeft = doc.el.scrollLeft;
  }

  function renderHighlights(doc, re) {
    if (!doc || !re || scope !== 'doc' || panel.hidden) {
      clearHighlights();
      return;
    }
    const ta = doc.el;
    const text = ta.value;
    if (text.length > HIGHLIGHT_MAX_CHARS) {
      clearHighlights();
      return;
    }
    const frag = document.createDocumentFragment();
    let last = 0;
    let marks = 0;
    let m;
    while ((m = re.exec(text)) && marks < HIGHLIGHT_MAX_MARKS) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      frag.append(mark);
      last = m.index + m[0].length;
      marks++;
    }
    frag.append(text.slice(last) + '\u200b');
    layer.replaceChildren(frag);
    positionLayer(ta);
    syncScroll();
  }

  /** Counts matches, marks the current one and returns the total. */
  function updateDocCount() {
    const doc = NP.editor.activeDoc();
    const re = buildPattern();
    countEl.classList.remove('none');
    if (!doc || !re) {
      countEl.textContent = '';
      clearHighlights();
      return 0;
    }
    renderHighlights(doc, buildPattern());
    const text = doc.el.value;
    const selStart = doc.el.selectionStart;
    const isCurrent = current && current.id === doc.id && selStart === current.index;
    let total = 0;
    let ordinal = 0;
    let m;
    while ((m = re.exec(text))) {
      total++;
      if (isCurrent && m.index <= current.index) ordinal = total;
    }
    const marks = layer.querySelectorAll('mark');
    if (isCurrent && ordinal && marks[ordinal - 1]) marks[ordinal - 1].classList.add('current');
    if (total === 0) {
      countEl.textContent = 'No results';
      countEl.classList.add('none');
    } else {
      countEl.textContent = isCurrent && ordinal ? `${ordinal} of ${total}` : `${total} found`;
    }
    return total;
  }

  function stepDoc(direction, fromCaret) {
    const doc = NP.editor.activeDoc();
    const re = buildPattern();
    if (!doc || !re) {
      current = null;
      updateDocCount();
      return;
    }
    const ta = doc.el;
    const text = ta.value;
    let hit = null;
    if (direction > 0) {
      re.lastIndex = fromCaret ? ta.selectionStart : ta.selectionEnd;
      hit = re.exec(text);
      if (!hit) {
        re.lastIndex = 0;
        hit = re.exec(text);
      }
    } else {
      let last = null;
      let lastBefore = null;
      let m;
      while ((m = re.exec(text))) {
        last = m;
        if (m.index < ta.selectionStart) lastBefore = m;
      }
      hit = lastBefore || last;
    }
    if (!hit) {
      current = null;
      updateDocCount();
      return;
    }
    ta.setSelectionRange(hit.index, hit.index + hit[0].length);
    NP.editor.revealRange(ta, hit.index, hit[0].length);
    current = { id: doc.id, index: hit.index };
    updateDocCount();
    syncScroll();
    NP.editor.updateCursor();
  }

  /* ---------------- workspace ---------------- */

  function updateWsCount() {
    countEl.classList.remove('none');
    if (!ws) {
      countEl.textContent = '';
    } else if (ws.running && !ws.occ) {
      countEl.textContent = 'Searching…';
    } else if (ws.done && ws.occ === 0) {
      countEl.textContent = 'No results';
      countEl.classList.add('none');
    } else {
      countEl.textContent = `${ws.occ.toLocaleString()} in ${ws.fileCount} file${ws.fileCount === 1 ? '' : 's'}${ws.truncated ? '+' : ''}`;
    }
  }

  function updateSummary() {
    if (!ws) return;
    let text;
    if (ws.error) text = `Search failed: ${ws.error}`;
    else if (ws.done && ws.occ === 0) text = 'No matches found in the workspace.';
    else {
      text = `${ws.running ? 'Searching… ' : ''}${ws.occ.toLocaleString()} match${ws.occ === 1 ? '' : 'es'} in ${ws.fileCount} file${ws.fileCount === 1 ? '' : 's'}`;
      if (ws.truncated) text += ' (showing the first results — refine your search)';
    }
    ws.summaryEl.textContent = text;
  }

  function previewNodes(occ) {
    const { preview, matchStart, length } = occ;
    const mark = el('mark', { text: preview.substr(matchStart, length) });
    return [preview.slice(0, matchStart), mark, preview.slice(matchStart + length)];
  }

  function appendFileGroup(file) {
    const sepIndex = Math.max(file.rel.lastIndexOf('/'), file.rel.lastIndexOf('\\'));
    const dir = sepIndex > 0 ? file.rel.slice(0, sepIndex) : '';
    const group = el('div', { class: 'sr-group' });
    group.append(
      el(
        'div',
        { class: 'sr-file', title: file.rel, dataset: { first: String(ws.flat.length) } },
        el('span', { class: 'tree-icon', html: /\.md$/i.test(file.name) ? icons.markdown : icons.text }),
        el('span', { class: 'sr-name', text: file.name }),
        el('span', { class: 'sr-dir', text: dir }),
        el('span', { class: 'sr-count', text: String(file.count) })
      )
    );
    for (const occ of file.occurrences) {
      const item = el(
        'div',
        { class: 'sr-item', dataset: { n: String(ws.flat.length) }, title: `Line ${occ.line}` },
        el('span', { class: 'sr-line', text: String(occ.line) }),
        el('span', { class: 'sr-preview' }, ...previewNodes(occ))
      );
      ws.flat.push({ file, occ, el: item });
      group.append(item);
    }
    if (file.count > file.occurrences.length) {
      group.append(el('div', { class: 'sr-more', text: `+ ${file.count - file.occurrences.length} more in this file` }));
    }
    ws.listEl.append(group);
  }

  function resetWs() {
    searchId++;
    if (ws) api.cancelSearch().catch(() => {});
    ws = null;
    resultsEl.replaceChildren();
    resultsEl.hidden = true;
  }

  function startWsSearch(force) {
    const query = input.value;
    if (!query) {
      resetWs();
      updateWsCount();
      return;
    }
    if (!force && !stale && query === lastQuery && caseSensitive === lastCase && ws && ws.done) return;
    lastQuery = query;
    lastCase = caseSensitive;
    stale = false;
    const id = ++searchId;
    const summaryEl = el('div', { class: 'sr-summary' });
    const listEl = el('div', { class: 'sr-list' });
    resultsEl.replaceChildren(
      summaryEl,
      el('div', { class: 'sr-note', text: 'Results reflect the saved contents of files on disk.' }),
      listEl
    );
    resultsEl.hidden = false;
    ws = { files: [], flat: [], occ: 0, fileCount: 0, selected: -1, truncated: false, done: false, running: true, error: null, summaryEl, listEl };
    updateSummary();
    updateWsCount();
    api
      .searchWorkspace({ query, caseSensitive, id })
      .then((res) => {
        if (id !== searchId || !ws || res.cancelled) return;
        ws.running = false;
        ws.done = true;
        ws.occ = res.totalOccurrences;
        ws.fileCount = res.totalFiles;
        ws.truncated = res.truncated;
        updateSummary();
        updateWsCount();
      })
      .catch((err) => {
        if (id !== searchId || !ws) return;
        ws.running = false;
        ws.error = err.message;
        updateSummary();
        notify(err.message, 'error');
      });
  }

  api.onSearchBatch(({ id, files }) => {
    if (id !== searchId || !ws) return;
    for (const file of files) {
      ws.files.push(file);
      ws.occ += file.count;
      ws.fileCount++;
      appendFileGroup(file);
    }
    updateSummary();
    updateWsCount();
  });

  /** Finds the match in the open document, tolerating unsaved edits that shifted the saved offsets. */
  function locate(doc, occ) {
    const text = doc.el.value;
    const slice = text.substr(occ.index, occ.length);
    const same = lastCase ? slice === lastQuery : slice.toLowerCase() === lastQuery.toLowerCase();
    if (same) return { index: occ.index, length: occ.length };
    const re = buildPattern(lastQuery, lastCase);
    let best = null;
    let m;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 100000) {
      if (!best || Math.abs(m.index - occ.index) < Math.abs(best.index - occ.index)) best = { index: m.index, length: m[0].length };
    }
    return best || { index: 0, length: 0 };
  }

  async function openResult(n, { focusEditor = true } = {}) {
    if (!ws || !ws.flat[n]) return;
    const prev = ws.flat[ws.selected];
    if (prev) prev.el.classList.remove('selected');
    ws.selected = n;
    const { file, occ, el: item } = ws.flat[n];
    item.classList.add('selected');
    item.scrollIntoView({ block: 'nearest' });
    await NP.editor.openFile(file.path);
    const doc = NP.editor.activeDoc();
    if (doc && doc.path === file.path) {
      const pos = locate(doc, occ);
      NP.editor.goTo(doc, pos.index, pos.length, { focus: focusEditor });
    }
    if (!focusEditor) input.focus();
  }

  function stepWs(direction) {
    if (!ws || !ws.flat.length) return;
    const count = ws.flat.length;
    const n = ws.selected < 0 ? (direction > 0 ? 0 : count - 1) : (ws.selected + direction + count) % count;
    openResult(n, { focusEditor: false });
  }

  resultsEl.addEventListener('click', (e) => {
    const item = e.target.closest('.sr-item');
    if (item) {
      openResult(Number(item.dataset.n));
      return;
    }
    const header = e.target.closest('.sr-file');
    if (header) openResult(Number(header.dataset.first));
  });

  /* ---------------- panel ---------------- */

  const runDocSearch = () => stepDoc(1, true);
  const debouncedWs = debounce(() => startWsSearch(false), 300);

  function setScope(next) {
    scope = next;
    scopeDoc.setAttribute('aria-pressed', String(next === 'doc'));
    scopeWs.setAttribute('aria-pressed', String(next === 'ws'));
    input.placeholder = next === 'doc' ? 'Find in document' : 'Search in workspace files';
    clearBtn.hidden = !input.value;
    if (next === 'ws') {
      clearHighlights();
      current = null;
      if (input.value) startWsSearch(false);
      else updateWsCount();
    } else {
      resetWs();
      if (input.value) updateDocCount();
      else countEl.textContent = '';
    }
  }

  function open(requested) {
    const hasWs = NP.explorer.hasWorkspace();
    const doc = NP.editor.activeDoc();
    let target = requested || scope;
    if (target === 'ws' && !hasWs) {
      notify('Open a folder to search the workspace.');
      target = 'doc';
    }
    if (target === 'doc' && !doc) {
      if (!hasWs) {
        notify('Open a document or folder first.');
        return;
      }
      target = 'ws';
    }
    panel.hidden = false;
    scopeWs.disabled = !hasWs;
    if (doc && target === 'doc') {
      const ta = doc.el;
      const selection = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (selection && selection.length < 200 && !selection.includes('\n')) input.value = selection;
    }
    setScope(target);
    input.focus();
    input.select();
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    clearHighlights();
    resetWs();
    current = null;
    NP.editor.focus();
  }

  function clear() {
    input.value = '';
    clearBtn.hidden = true;
    current = null;
    if (scope === 'ws') {
      resetWs();
      updateWsCount();
    } else {
      updateDocCount();
    }
    input.focus();
  }

  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    if (scope === 'doc') runDocSearch();
    else if (input.value) debouncedWs();
    else clear();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (scope === 'doc') stepDoc(e.shiftKey ? -1 : 1, false);
      else if (stale || input.value !== lastQuery || caseSensitive !== lastCase || !ws) startWsSearch(true);
      else stepWs(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  caseBtn.addEventListener('click', () => {
    caseSensitive = !caseSensitive;
    caseBtn.setAttribute('aria-pressed', String(caseSensitive));
    if (scope === 'doc') runDocSearch();
    else startWsSearch(true);
  });
  scopeDoc.addEventListener('click', () => open('doc'));
  scopeWs.addEventListener('click', () => open('ws'));
  clearBtn.addEventListener('click', clear);
  $('find-next').addEventListener('click', () => (scope === 'doc' ? stepDoc(1, false) : stepWs(1)));
  $('find-prev').addEventListener('click', () => (scope === 'doc' ? stepDoc(-1, false) : stepWs(-1)));
  $('find-close').addEventListener('click', close);

  const onDocChanged = () => {
    if (!panel.hidden && scope === 'doc' && input.value) updateDocCount();
  };

  NP.find = {
    open,
    close,
    isOpen: () => !panel.hidden,
    refresh: onDocChanged,
    onDocChanged,
    syncScroll,
    markStale: () => {
      stale = true;
    },
    /** The workspace changed: drop old results and re-run if the workspace panel is open. */
    reset: () => {
      stale = true;
      scopeWs.disabled = !NP.explorer.hasWorkspace();
      if (!panel.hidden && scope === 'ws') {
        resetWs();
        if (input.value) startWsSearch(true);
      }
    }
  };
})();
