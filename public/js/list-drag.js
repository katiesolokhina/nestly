// Drag to rearrange a settings list (stores, aisles, categories...). Saves when the row is let go;
// the arrows still work without JavaScript. Textareas marked data-grow get taller as you type.
(function () {
  document.querySelectorAll('[data-drag-list]').forEach((list) => {
    const key = list.dataset.dragList;
    list.querySelectorAll('[data-drag-handle]').forEach((h) => { h.hidden = false; });
    let row = null;
    let startOrder = '';
    const order = () => [...list.children].map((li) => li.dataset.value);

    function arrows() {
      const rows = [...list.children];
      rows.forEach((li, i) => {
        const [up, down] = li.querySelectorAll('.mini');
        if (up) up.disabled = i === 0;
        if (down) down.disabled = i === rows.length - 1;
      });
    }

    async function save() {
      const body = new URLSearchParams([['action', 'order'], ...order().map((v) => ['value', v])]);
      try {
        const res = await fetch(`/settings/lists/${encodeURIComponent(key)}`, { method: 'POST', body, credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } });
        if (!res.ok) throw new Error();
      } catch {
        location.reload(); // show what's actually saved
      }
    }

    list.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('[data-drag-handle]');
      if (!handle) return;
      e.preventDefault();
      row = handle.closest('li');
      startOrder = order().join('\u0001');
      row.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
    });
    list.addEventListener('pointermove', (e) => {
      if (!row) return;
      const others = [...list.children].filter((li) => li !== row);
      const before = others.find((li) => { const r = li.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
      if (before) { if (row.nextElementSibling !== before) list.insertBefore(row, before); } else if (list.lastElementChild !== row) list.append(row);
    });
    const drop = () => {
      if (!row) return;
      row.classList.remove('dragging');
      row = null;
      arrows();
      if (order().join('\u0001') !== startOrder) save();
    };
    list.addEventListener('pointerup', drop);
    list.addEventListener('pointercancel', drop);
  });

  document.querySelectorAll('textarea[data-grow]').forEach((t) => {
    const fit = () => { t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; };
    t.addEventListener('input', fit);
    // Enter adds; Shift+Enter starts a new line.
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); t.form.requestSubmit(t.form.querySelector('[type=submit]')); } });
  });
})();
