(function () {
  'use strict';

  const NP = window.NP;
  const { el, notify } = NP;
  const $ = (id) => document.getElementById(id);

  const styleSel = $('fmt-style');
  const boldBtn = $('fmt-bold');
  const italicBtn = $('fmt-italic');
  const strikeBtn = $('fmt-strike');
  const tableBtn = $('fmt-table');
  const controls = [styleSel, boldBtn, italicBtn, strikeBtn, tableBtn];
  const LARGE_DOC_CHARS = 300000;

  // Title/Heading 1 and Subtitle/Heading 2 share Markdown syntax; position in the document tells them apart.
  const PREFIX = { title: '# ', subtitle: '## ', h1: '# ', h2: '## ', h3: '### ', section: '#### ', body: '' };
  const HEADING_PREFIX = /^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/;

  /** Replaces a range through execCommand so the edit joins the native undo stack. */
  function replaceRange(ta, from, to, text) {
    ta.focus();
    if (from === to && text === '') return;
    ta.setSelectionRange(from, to);
    const ok = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text);
    if (!ok) {
      ta.setRangeText(text, from, to, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function noteForPlainText(doc) {
    if (doc.fmtNotice || /\.md$/i.test(doc.name)) return;
    doc.fmtNotice = true;
    notify('Markdown markers were added. In a .txt file they remain ordinary visible characters.');
  }

  /* ---------------- text styles ---------------- */

  function detectStyle(text, pos) {
    const lineStart = pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;
    let lineEnd = text.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = text.length;
    const m = /^(#{1,6})(?:[ \t]|$)/.exec(text.slice(lineStart, lineEnd));
    if (!m) return 'body';
    const level = m[1].length;
    if (level === 1) return /^# /m.test(text.slice(0, lineStart)) ? 'h1' : 'title';
    if (level === 2) {
      let end = lineStart - 1;
      while (end >= 0) {
        const start = end === 0 ? 0 : text.lastIndexOf('\n', end - 1) + 1;
        const prev = text.slice(start, end);
        if (prev.trim()) {
          if (/^# /.test(prev) && !/^# /m.test(text.slice(0, start))) return 'subtitle';
          break;
        }
        end = start - 1;
      }
      return 'h2';
    }
    return level === 3 ? 'h3' : 'section';
  }

  function applyStyle(name) {
    const doc = NP.editor.activeDoc();
    if (!doc || !(name in PREFIX)) return;
    const ta = doc.el;
    const text = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
    const lastChar = end > start && text[end - 1] === '\n' ? end - 1 : end;
    let lineEnd = text.indexOf('\n', lastChar);
    if (lineEnd === -1) lineEnd = text.length;

    const original = text.slice(lineStart, lineEnd);
    const lines = original.split('\n');
    const converted = lines.map((line) => (line.trim() || lines.length === 1 ? PREFIX[name] + line.replace(HEADING_PREFIX, '') : line));
    const next = converted.join('\n');
    if (next === original) {
      ta.focus();
      return;
    }
    replaceRange(ta, lineStart, lineEnd, next);
    if (lines.length === 1) {
      const oldPrefix = HEADING_PREFIX.exec(original);
      const caret = lineStart + PREFIX[name].length + Math.max(0, start - lineStart - (oldPrefix ? oldPrefix[0].length : 0));
      ta.setSelectionRange(Math.min(caret, lineStart + next.length), Math.min(caret, lineStart + next.length));
    } else {
      ta.setSelectionRange(lineStart, lineStart + next.length);
    }
    noteForPlainText(doc);
  }

  /* ---------------- inline formatting ---------------- */

  function toggleInline(marker) {
    const doc = NP.editor.activeDoc();
    if (!doc) return;
    const ta = doc.el;
    const text = ta.value;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const m = marker.length;
    const ch = marker[0];
    const runBefore = (i) => {
      let n = 0;
      for (let k = i - 1; k >= 0 && text[k] === ch; k--) n++;
      return n;
    };
    const runAfter = (i) => {
      let n = 0;
      for (let k = i; k < text.length && text[k] === ch; k++) n++;
      return n;
    };
    // Italic is present when the surrounding run of '*' is odd (so ** is bold only and *** is both).
    const present = (a, b) => (m === 1 ? a % 2 === 1 && b % 2 === 1 : a >= m && b >= m);

    noteForPlainText(doc);
    if (s === e) {
      if (present(runBefore(s), runAfter(s)) && text.slice(s - m, s) === marker && text.slice(s, s + m) === marker) {
        replaceRange(ta, s - m, s + m, '');
        ta.setSelectionRange(s - m, s - m);
      } else {
        replaceRange(ta, s, s, marker + marker);
        ta.setSelectionRange(s + m, s + m);
      }
      return;
    }

    const sel = text.slice(s, e);
    let lead = 0;
    while (lead < sel.length && sel[lead] === ch) lead++;
    let trail = 0;
    while (trail < sel.length - lead && sel[sel.length - 1 - trail] === ch) trail++;
    if (sel.length > lead + trail && present(lead, trail)) {
      const inner = sel.slice(m, sel.length - m);
      replaceRange(ta, s, e, inner);
      ta.setSelectionRange(s, s + inner.length);
      return;
    }
    if (present(runBefore(s), runAfter(e))) {
      replaceRange(ta, s - m, e + m, sel);
      ta.setSelectionRange(s - m, s - m + sel.length);
      return;
    }
    const leadWs = /^\s*/.exec(sel)[0].length;
    const trailWs = /\s*$/.exec(sel)[0].length;
    if (leadWs === sel.length) {
      replaceRange(ta, e, e, marker + marker);
      ta.setSelectionRange(e + m, e + m);
      return;
    }
    const core = sel.slice(leadWs, sel.length - trailWs);
    replaceRange(ta, s, e, sel.slice(0, leadWs) + marker + core + marker + sel.slice(sel.length - trailWs));
    ta.setSelectionRange(s + leadWs + m, s + leadWs + m + core.length);
  }

  const SPANS = {
    '**': /\*\*(.+?)\*\*/g,
    '*': /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
    '~~': /~~(.+?)~~/g
  };

  /** Used only for the toolbar's active state: is the position inside a span of this kind on its line? */
  function activeAt(text, pos, marker) {
    const lineStart = pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;
    let lineEnd = text.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = text.length;
    const re = new RegExp(SPANS[marker].source, 'g');
    const line = text.slice(lineStart, lineEnd);
    let m;
    while ((m = re.exec(line))) {
      const from = lineStart + m.index + marker.length;
      const to = lineStart + m.index + m[0].length - marker.length;
      if (pos >= from && pos <= to) return true;
    }
    return false;
  }

  /* ---------------- tables ---------------- */

  function buildTable(rows, cols) {
    const headers = Array.from({ length: cols }, (_, i) => `Column ${i + 1}`);
    const widths = headers.map((h) => Math.max(h.length, 3));
    const pad = (value, i) => value + ' '.repeat(widths[i] - value.length);
    const line = (cells) => `| ${cells.map(pad).join(' | ')} |`;
    const out = [line(headers), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`];
    for (let r = 0; r < rows; r++) out.push(line(Array(cols).fill('')));
    return { text: out.join('\n'), firstCell: headers[0] };
  }

  async function insertTable() {
    const doc = NP.editor.activeDoc();
    if (!doc) return;
    const rowsInput = el('input', { type: 'number', min: '1', max: '50', value: '3', 'aria-label': 'Rows' });
    const colsInput = el('input', { type: 'number', min: '1', max: '12', value: '3', 'aria-label': 'Columns' });
    const form = el(
      'div',
      { class: 'form-grid' },
      el('label', {}, el('span', { text: 'Rows (excluding header)' }), rowsInput),
      el('label', {}, el('span', { text: 'Columns' }), colsInput)
    );
    const choice = await NP.dialog.show({
      title: 'Insert Table',
      message: 'Choose the size of the Markdown table.',
      content: form,
      initialFocus: rowsInput,
      buttons: [
        { label: 'Insert', value: 'ok', primary: true },
        { label: 'Cancel', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    });
    if (choice !== 'ok' || doc.closed) return;
    const clamp = (v, lo, hi, fallback) => Math.min(hi, Math.max(lo, Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : fallback));
    const { text: table, firstCell } = buildTable(clamp(rowsInput.value, 1, 50, 3), clamp(colsInput.value, 1, 12, 3));

    const ta = doc.el;
    const value = ta.value;
    const pos = ta.selectionEnd;
    const lineStart = pos === 0 ? 0 : value.lastIndexOf('\n', pos - 1) + 1;
    let prefix = '';
    if (pos !== lineStart) prefix = '\n\n';
    else if (lineStart > 0 && value[lineStart - 2] !== '\n' && value[lineStart - 1] === '\n') prefix = '\n';
    const suffix = pos < value.length && value[pos] !== '\n' ? '\n\n' : '\n';
    replaceRange(ta, pos, pos, prefix + table + suffix);
    const cellStart = pos + prefix.length + 2;
    ta.setSelectionRange(cellStart, cellStart + firstCell.length);
    noteForPlainText(doc);
  }

  /* ---------------- toolbar state ---------------- */

  function refresh() {
    const doc = NP.editor.activeDoc();
    for (const control of controls) control.disabled = !doc;
    if (!doc) {
      for (const b of [boldBtn, italicBtn, strikeBtn]) b.setAttribute('aria-pressed', 'false');
      styleSel.value = 'body';
    }
  }

  function onCursorChange(text) {
    const doc = NP.editor.activeDoc();
    if (!doc || typeof text !== 'string') return;
    const pos = doc.el.selectionStart;
    styleSel.value = detectStyle(text, pos);
    if (text.length > LARGE_DOC_CHARS) return;
    boldBtn.setAttribute('aria-pressed', String(activeAt(text, pos, '**')));
    italicBtn.setAttribute('aria-pressed', String(activeAt(text, pos, '*')));
    strikeBtn.setAttribute('aria-pressed', String(activeAt(text, pos, '~~')));
  }

  styleSel.addEventListener('change', () => NP.format.applyStyle(styleSel.value));
  boldBtn.addEventListener('click', () => NP.format.bold());
  italicBtn.addEventListener('click', () => NP.format.italic());
  strikeBtn.addEventListener('click', () => NP.format.strike());
  tableBtn.addEventListener('click', () => NP.format.insertTable());
  $('fmt-search').addEventListener('click', () => NP.find.open('doc'));

  // Toolbar actions change the selection programmatically, so refresh the status bar and active states afterwards.
  const after = (fn) => (...args) => {
    const result = fn(...args);
    Promise.resolve(result).then(() => NP.editor.updateCursor());
  };

  NP.format = {
    refresh,
    onCursorChange,
    applyStyle: after(applyStyle),
    bold: after(() => toggleInline('**')),
    italic: after(() => toggleInline('*')),
    strike: after(() => toggleInline('~~')),
    insertTable: after(insertTable)
  };
})();
