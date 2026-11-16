// Settings → Defaults: a default's value is only used when it's on, so hide the picker when it's off.
document.querySelectorAll('[data-def]').forEach((row) => {
  const on = row.querySelector('[data-def-on]');
  const value = row.querySelector('[data-def-value]');
  const off = row.querySelector('[data-def-off]');
  const update = () => { if (value) value.hidden = !on.checked; if (off) off.hidden = on.checked; };
  on.addEventListener('change', update);
  update();
});
