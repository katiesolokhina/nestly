// Shows only the event fields that apply. Without JavaScript every field shows and still works.
document.querySelectorAll('form[data-event-form]').forEach((form) => {
  const allDay = form.querySelector('[data-all-day]');
  const repeat = form.querySelector('[data-repeat]');
  const unit = form.querySelector('[data-unit]');
  const units = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' };
  const update = () => {
    form.querySelectorAll('[data-times]').forEach((el) => { el.hidden = allDay.checked; });
    form.querySelectorAll('[data-repeat-only]').forEach((el) => { el.hidden = repeat.value === 'none'; });
    form.querySelectorAll('[data-weekly-only]').forEach((el) => { el.hidden = repeat.value !== 'weekly'; });
    if (unit && units[repeat.value]) unit.textContent = `Number of ${units[repeat.value]} between each one`;
  };
  form.addEventListener('change', update);
  update();
});
