// Shows the extra fields under a checkbox (data-toggle) only while it's ticked.
document.querySelectorAll('[data-toggle-group]').forEach((group) => {
  const box = group.querySelector('[data-toggle]');
  const parts = group.querySelectorAll('[data-toggled]');
  const update = () => parts.forEach((p) => { p.hidden = !box.checked; });
  box.addEventListener('change', update);
  update();
});
