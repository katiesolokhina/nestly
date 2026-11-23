// Pantry select mode: "Select all here" for each spot, the count, and asking before Delete.
document.querySelectorAll('[data-bulk-form]').forEach((form) => {
  const items = [...form.querySelectorAll('[data-bulk-item]')];
  const count = form.querySelector('[data-bulk-count]');
  const apply = form.querySelector('[data-bulk-apply]');
  const del = form.querySelector('[data-bulk-delete]');
  const update = () => {
    const n = items.filter((i) => i.checked).length;
    count.textContent = n ? `${n} selected` : 'Tick items, or Select all in a spot';
    if (apply) apply.disabled = !n;
    const merge = form.querySelector('[data-bulk-merge]');
    if (merge) { merge.disabled = n < 2; merge.textContent = n > 1 ? `Merge ${n} into one` : 'Merge into one (pick 2 or more)'; }
    if (del) { del.disabled = !n; del.textContent = n ? `Delete ${n} selected` : 'Delete selected'; }
    form.querySelectorAll('[data-bulk-group]').forEach((g) => {
      const boxes = [...g.querySelectorAll('[data-bulk-item]')];
      const all = boxes.length && boxes.every((b) => b.checked);
      const btn = g.querySelector('[data-bulk-all]');
      btn.firstChild.textContent = all ? 'Unselect these' : 'Select all here';
    });
  };
  form.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bulk-all]');
    if (btn) {
      const boxes = [...btn.closest('[data-bulk-group]').querySelectorAll('[data-bulk-item]')];
      const on = !boxes.every((b) => b.checked);
      boxes.forEach((b) => { b.checked = on; });
      update();
    }
    if (e.target.closest('[data-bulk-delete]') && !window.confirm(del.dataset.confirm)) e.preventDefault();
  });
  form.addEventListener('change', update);
  update();
});
