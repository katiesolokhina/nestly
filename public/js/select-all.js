// Select mode: "Select all", and a Delete button that says how many are picked.
document.querySelectorAll('[data-select-form]').forEach((form) => {
  const all = form.querySelector('[data-select-all]');
  const items = [...form.querySelectorAll('[data-select-item]')];
  const btn = form.querySelector('[data-select-count]');
  const update = () => {
    const n = items.filter((i) => i.checked).length;
    btn.textContent = n ? `Delete ${n} selected` : 'Delete selected';
    btn.disabled = !n;
    if (all) { all.checked = n === items.length; all.indeterminate = n > 0 && n < items.length; }
  };
  if (all) all.addEventListener('change', () => { items.forEach((i) => { i.checked = all.checked; }); update(); });
  items.forEach((i) => i.addEventListener('change', update));
  update();
});
