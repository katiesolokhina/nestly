// "No date" next to a use-by date: clears it (some phones' date pickers have no way to).
// On the item page, also adds a fresh line when the last one is filled in.
document.querySelectorAll('[data-clear-date]').forEach(function wire(btn) {
  const input = btn.parentElement.querySelector('input[type="date"]');
  if (!input) return;
  const show = () => { btn.hidden = !input.value; };
  btn.addEventListener('click', () => { input.value = ''; show(); input.focus(); });
  input.addEventListener('input', show);
  input.addEventListener('change', show);
  show();
});

document.querySelectorAll('[data-batches]').forEach((box) => {
  box.addEventListener('input', (e) => {
    const rows = box.querySelectorAll('[data-batch-row]');
    const last = rows[rows.length - 1];
    if (!last.contains(e.target) || !last.querySelector('[name="bCount"]').value) return;
    const row = last.cloneNode(true);
    const n = rows.length;
    row.querySelectorAll('input').forEach((i) => { i.value = i.dataset.default || ''; i.id = i.id.replace(/-\d+$/, `-${n}`); });
    row.querySelectorAll('label').forEach((l) => { l.htmlFor = l.htmlFor.replace(/-\d+$/, `-${n}`); });
    row.querySelectorAll('[data-clear-date]').forEach((btn) => {
      const input = btn.parentElement.querySelector('input[type="date"]');
      btn.hidden = !input.value;
      btn.addEventListener('click', () => { input.value = ''; btn.hidden = true; input.focus(); });
      input.addEventListener('change', () => { btn.hidden = !input.value; });
    });
    last.after(row);
  });
});
