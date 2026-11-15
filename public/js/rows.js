// Add and remove rows in a form (Home info starting fields). The last row is cleared, not removed.
document.querySelectorAll('[data-rows-form]').forEach((form) => {
  const box = form.querySelector('[data-rows]');
  form.querySelector('[data-row-add]').addEventListener('click', () => {
    const row = box.querySelector('[data-row]').cloneNode(true);
    row.querySelectorAll('input').forEach((i) => { i.value = ''; });
    row.querySelectorAll('select').forEach((s) => { s.selectedIndex = 0; });
    box.appendChild(row);
    row.querySelector('input').focus();
  });
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-row-remove]');
    if (!btn) return;
    const row = btn.closest('[data-row]');
    if (box.querySelectorAll('[data-row]').length > 1) row.remove();
    else row.querySelectorAll('input').forEach((i) => { i.value = ''; });
  });
});
