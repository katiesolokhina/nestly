// Recipe form: add and remove ingredient rows. Without JavaScript, the three empty rows still work.
document.querySelectorAll('[data-recipe-form]').forEach((form) => {
  const rows = form.querySelector('[data-ing-rows]');
  const add = form.querySelector('[data-ing-add]');
  if (!rows || !add) return;
  const blankRow = () => {
    const row = rows.querySelector('[data-ing-row]').cloneNode(true);
    row.querySelectorAll('input').forEach((i) => { i.value = ''; });
    return row;
  };
  add.addEventListener('click', () => {
    const row = blankRow();
    rows.appendChild(row);
    row.querySelector('.ing-qty').focus();
  });
  rows.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ing-remove]');
    if (!btn) return;
    const row = btn.closest('[data-ing-row]');
    if (rows.querySelectorAll('[data-ing-row]').length > 1) row.remove();
    else row.querySelectorAll('input').forEach((i) => { i.value = ''; });
  });
  // Enter in the last ingredient adds a new row instead of saving the form.
  rows.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('.ing-name, .ing-qty')) return;
    e.preventDefault();
    const row = e.target.closest('[data-ing-row]');
    if (row === rows.lastElementChild) add.click();
    else row.nextElementSibling.querySelector('.ing-qty').focus();
  });
});
