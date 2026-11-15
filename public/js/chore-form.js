// Shows only the repeat fields that apply. Without JavaScript every field shows and still works.
document.querySelectorAll('form[data-chore-form]').forEach((form) => {
  const repeat = form.querySelector('[data-repeat]');
  const unit = form.querySelector('[data-unit]');
  const dateLabel = form.querySelector('[data-date-label]');
  const units = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' };
  const update = () => {
    form.querySelectorAll('[data-repeat-only]').forEach((el) => { el.hidden = repeat.value === 'none'; });
    form.querySelectorAll('[data-weekly-only]').forEach((el) => { el.hidden = repeat.value !== 'weekly'; });
    if (unit && units[repeat.value]) unit.textContent = `Number of ${units[repeat.value]} between each one`;
    if (dateLabel) dateLabel.textContent = repeat.value === 'none' ? 'Due' : 'First due';
  };
  repeat.addEventListener('change', update);
  update();
});
