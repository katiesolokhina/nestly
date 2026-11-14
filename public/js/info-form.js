// Home info form: add and remove fields, and match each value box to its kind.
document.querySelectorAll('[data-info-form]').forEach((form) => {
  const box = form.querySelector('[data-fields]');
  const add = form.querySelector('[data-field-add]');
  const TYPES = { date: 'date', email: 'email', phone: 'tel' };
  const fit = (row) => {
    const kind = row.querySelector('[data-kind]').value;
    const input = row.querySelector('.info-value');
    const type = TYPES[kind] || 'text';
    if (input.type !== type) {
      if (type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(input.value)) input.value = '';
      input.type = type;
    }
    input.autocapitalize = ['secret', 'email', 'link'].includes(kind) ? 'off' : 'sentences';
    input.placeholder = { link: 'https://...', phone: 'Phone number', email: 'name@example.com', secret: 'Hidden until someone taps Show', address: 'Street, city' }[kind] || '';
  };
  box.querySelectorAll('[data-field]').forEach(fit);
  box.addEventListener('change', (e) => { if (e.target.matches('[data-kind]')) fit(e.target.closest('[data-field]')); });
  add.addEventListener('click', () => {
    const row = box.querySelector('[data-field]').cloneNode(true);
    row.querySelectorAll('input').forEach((i) => { i.value = ''; });
    row.querySelector('[data-kind]').value = 'text';
    fit(row);
    box.appendChild(row);
    row.querySelector('.info-label').focus();
  });
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-field-remove]');
    if (!btn) return;
    const row = btn.closest('[data-field]');
    if (box.querySelectorAll('[data-field]').length > 1) row.remove();
    else row.querySelectorAll('input').forEach((i) => { i.value = ''; });
  });
});
