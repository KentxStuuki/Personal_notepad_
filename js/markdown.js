(function () {
  'use strict';

  const NP = window.NP;
  const { el } = NP;
  const $ = (id) => document.getElementById(id);

  const pane = $('preview');
  const toggleBtn = $('fmt-preview');
  const MAX_CHARS = 300000;
  let open = false;

  /* ---------------- inline ---------------- */

  // 1 code, 2 bold+italic, 3 bold, 4 strike, 5 italic, 6 link/image text, 7 url
  const INLINE = /`([^`]+)`|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|~~(.+?)~~|(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])|!?\[([^\]]*)\]\(([^)]*)\)/;

  function inline(text) {
    const out = [];
    let rest = text;
    while (rest) {
      const m = INLINE.exec(rest);
      if (!m) {
        out.push(rest);
        break;
      }
      if (m.index > 0) out.push(rest.slice(0, m.index));
      if (m[1] !== undefined) out.push(el('code', { text: m[1] }));
      else if (m[2] !== undefined) out.push(el('strong', {}, el('em', {}, ...inline(m[2]))));
      else if (m[3] !== undefined) out.push(el('strong', {}, ...inline(m[3])));
      else if (m[4] !== undefined) out.push(el('del', {}, ...inline(m[4])));
      else if (m[5] !== undefined) out.push(el('em', {}, ...inline(m[5])));
      else out.push(el('span', { class: m[0][0] === '!' ? 'md-img' : 'md-link', text: m[6] || m[7] }));
      rest = rest.slice(m.index + m[0].length);
    }
    return out;
  }

  /* ---------------- blocks ---------------- */

  const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])[ \t]+(.*)$/;
  const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/;
  const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const FENCE = /^\s*(```|~~~)/;

  const splitRow = (row) =>
    row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

  const startsBlock = (line, next) =>
    HEADING.test(line) || FENCE.test(line) || RULE.test(line) || LIST_ITEM.test(line) || /^\s*>/.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEP.test(next));

  function renderMarkdown(text, root) {
    const lines = text.split('\n');
    let titleSeen = false;
    let afterTitle = false;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      const keepTitle = afterTitle;
      afterTitle = false;

      const fence = FENCE.exec(line);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
        i++;
        root.append(el('pre', { class: 'md-code' }, el('code', { text: body.join('\n') })));
        continue;
      }

      const h = HEADING.exec(line);
      if (h) {
        const level = h[1].length;
        let cls = '';
        if (level === 1) {
          cls = titleSeen ? 'md-h1' : 'md-title';
          if (!titleSeen) afterTitle = true;
          titleSeen = true;
        } else if (level === 2 && keepTitle) cls = 'md-subtitle';
        else if (level === 4) cls = 'md-section';
        root.append(el(`h${level}`, { class: cls }, ...inline(h[2])));
        i++;
        continue;
      }

      if (RULE.test(line)) {
        root.append(el('hr'));
        i++;
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : 'left'));
        i += 2;
        const tbody = el('tbody');
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const cells = splitRow(lines[i++]);
          tbody.append(el('tr', {}, ...head.map((_, c) => {
            const td = el('td', {}, ...inline(cells[c] || ''));
            td.style.textAlign = aligns[c] || 'left';
            return td;
          })));
        }
        const headRow = el('tr', {}, ...head.map((cell, c) => {
          const th = el('th', {}, ...inline(cell));
          th.style.textAlign = aligns[c] || 'left';
          return th;
        }));
        root.append(el('div', { class: 'md-table-wrap' }, el('table', {}, el('thead', {}, headRow), tbody)));
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
        root.append(el('blockquote', {}, el('p', {}, ...inline(quote.join(' ')))));
        continue;
      }

      const item = LIST_ITEM.exec(line);
      if (item) {
        const ordered = /\d/.test(item[2]);
        const list = el(ordered ? 'ol' : 'ul');
        while (i < lines.length) {
          const m = LIST_ITEM.exec(lines[i]);
          if (!m) break;
          const li = el('li', {}, ...inline(m[3]));
          li.style.marginLeft = `${Math.min(6, Math.floor(m[1].replace(/\t/g, '  ').length / 2)) * 16}px`;
          list.append(li);
          i++;
        }
        root.append(list);
        continue;
      }

      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++]);
      root.append(el('p', {}, ...inline(para.join(' '))));
    }
  }

  /* ---------------- pane ---------------- */

  function update() {
    if (!open) return;
    const doc = NP.editor.activeDoc();
    if (!doc) {
      pane.replaceChildren();
      return;
    }
    const value = doc.el.value;
    const text = value.length > MAX_CHARS ? value.slice(0, MAX_CHARS) : value;
    const body = el('div', { class: 'md' });
    if (/\.md$/i.test(doc.name)) renderMarkdown(text, body);
    else body.append(el('pre', { class: 'md-plain', text }));
    const kids = [body];
    if (value.length > MAX_CHARS) kids.push(el('p', { class: 'md-note', text: 'Preview limited to the first 300,000 characters.' }));
    if (!/\.md$/i.test(doc.name)) kids.push(el('p', { class: 'md-note', text: 'Plain-text file: shown without Markdown rendering.' }));
    pane.replaceChildren(...kids);
    syncScroll();
  }

  function syncScroll() {
    if (!open) return;
    const doc = NP.editor.activeDoc();
    if (!doc) return;
    const ta = doc.el;
    const range = ta.scrollHeight - ta.clientHeight;
    pane.scrollTop = range > 0 ? (ta.scrollTop / range) * (pane.scrollHeight - pane.clientHeight) : 0;
  }

  function toggle() {
    open = !open;
    pane.hidden = !open;
    toggleBtn.setAttribute('aria-pressed', String(open));
    if (open) update();
    else pane.replaceChildren();
    NP.find.onDocChanged();
  }

  toggleBtn.addEventListener('click', toggle);

  NP.preview = { toggle, update, syncScroll, isOpen: () => open };
})();
