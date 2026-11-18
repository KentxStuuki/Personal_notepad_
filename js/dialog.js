(function () {
  'use strict';

  const NP = window.NP;
  const { el } = NP;
  const root = document.getElementById('modal-root');

  function show({ title, message, detail, content, initialFocus, buttons, cancelValue }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;

      const close = (value) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (previous && typeof previous.focus === 'function') previous.focus();
        resolve(value);
      };

      const buttonEls = buttons.map((b) =>
        el('button', {
          class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''),
          type: 'button',
          text: b.label,
          onclick: () => close(b.value)
        })
      );

      const box = el(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        el('h2', { class: 'modal-title', text: title }),
        el('p', { class: 'modal-message', text: message }),
        detail ? el('p', { class: 'modal-detail', text: detail }) : null,
        content || null,
        el('div', { class: 'modal-actions' }, ...buttonEls)
      );
      const overlay = el('div', { class: 'modal-overlay' }, box);

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close(cancelValue);
        } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
          e.preventDefault();
          const primary = buttons.findIndex((b) => b.primary);
          if (primary >= 0) buttonEls[primary].click();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const focusables = [...box.querySelectorAll('input, select, button')];
          const i = focusables.indexOf(document.activeElement);
          const step = e.shiftKey ? -1 : 1;
          focusables[(i + step + focusables.length) % focusables.length].focus();
        }
      }

      document.addEventListener('keydown', onKey, true);
      root.append(overlay);
      const primary = buttons.findIndex((b) => b.primary);
      if (initialFocus) {
        initialFocus.focus();
        if (initialFocus.select) initialFocus.select();
      } else {
        buttonEls[primary >= 0 ? primary : 0].focus();
      }
    });
  }

  NP.dialog = {
    show,
    isOpen: () => root.childElementCount > 0,
    alert: (title, message) =>
      show({ title, message, buttons: [{ label: 'OK', value: true, primary: true }], cancelValue: true })
  };
})();
