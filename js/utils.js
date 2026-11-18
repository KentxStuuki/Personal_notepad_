(function () {
  'use strict';

  const NP = (window.NP = window.NP || {});

  NP.api = window.notepad;
  NP.isMac = NP.api.platform === 'darwin';
  NP.SEP = NP.api.platform === 'win32' ? '\\' : '/';

  const svg = (body) =>
    `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

  NP.icons = {
    chevron: svg('<path d="m9 6 6 6-6 6"/>'),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    folderOpen: svg('<path d="M3 8V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 10h18l-2 7.5a2 2 0 0 1-2 1.5H5a2 2 0 0 1-2-2z"/>'),
    text: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'),
    markdown: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15V9l2.5 3L12 9v6M16 9v6m0 0-2-2m2 2 2-2"/>'),
    file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>')
  };

  /** Creates a DOM element. Only static, trusted strings may be passed through `html`. */
  NP.el = function el(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...kids.filter(Boolean));
    return node;
  };

  NP.debounce = function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  };

  NP.baseName = (p) => p.slice(p.lastIndexOf(NP.SEP) + 1);
  NP.parentOf = (p) => p.slice(0, p.lastIndexOf(NP.SEP)) || NP.SEP;
  NP.isUnder = (p, dir) => p === dir || p.startsWith(dir + NP.SEP);

  /** Counts words (runs of non-whitespace) and characters (Unicode code points, spaces and line breaks included). */
  NP.countText = function countText(text) {
    let words = 0;
    let chars = text.length;
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) chars--;
      const space =
        c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
        c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
      if (space) inWord = false;
      else if (!inWord) {
        inWord = true;
        words++;
      }
    }
    return { words, chars };
  };

  NP.storage = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem('np.' + key);
        return value === null ? fallback : value;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('np.' + key, String(value));
      } catch {
        /* storage unavailable */
      }
    }
  };

  let messageTimer = null;
  NP.notify = function notify(message, kind = 'info') {
    const node = document.getElementById('stat-message');
    node.textContent = message;
    node.dataset.kind = kind;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => {
      node.textContent = '';
    }, kind === 'error' ? 7000 : 3500);
  };
})();
