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
  // The end date follows the start date until someone sets a different end date.
  const start = form.querySelector('[data-start-date]');
  const end = form.querySelector('[data-end-date]');
  let lastStart = start.value;
  start.addEventListener('change', () => {
    if (!end.value || end.value === lastStart || end.value < start.value) end.value = start.value;
    end.min = start.value;
    lastStart = start.value;
  });
  // Notify: list only the choices that fit a timed or all-day event. Options are rebuilt rather
  // than hidden, because iPhone ignores hidden options. Custom shows its own fields.
  const alert = form.querySelector('[data-alert]');
  const custom = form.querySelector('[data-alert-custom]');
  const all = alert ? [...alert.options].map((o) => o.cloneNode(true)) : [];
  let kind = null;
  const updateAlert = () => {
    if (!alert) return;
    const next = allDay.checked ? 'allday' : 'timed';
    if (next !== kind) {
      const keep = alert.value;
      const fits = all.filter((o) => o.dataset.kind === 'both' || o.dataset.kind === next);
      alert.replaceChildren(...fits.map((o) => o.cloneNode(true)));
      const fallback = next === 'allday' ? alert.dataset.defaultAllday || '0' : alert.dataset.defaultTimed || '60';
      // Switching between timed and all day: keep None or Custom, otherwise start from the usual choice.
      alert.value = keep === 'none' || keep === 'custom' ? keep : fallback;
      // On first load, keep the option the server picked for this kind.
      if (kind === null) {
        const chosen = fits.find((o) => o.defaultSelected);
        if (chosen) alert.value = chosen.value;
      }
      kind = next;
    }
    if (custom) custom.hidden = alert.value !== 'custom';
  };
  // Who it's for: Everyone hides the list of people.
  const forAll = form.querySelector('[data-for-all]');
  const forPeople = form.querySelector('[data-for-people]');
  const updateFor = () => { if (forAll && forPeople) forPeople.hidden = forAll.checked; };
  if (forAll) forAll.addEventListener('change', () => {
    updateFor();
  });
  if (forPeople) forPeople.addEventListener('change', () => { if (forAll && forPeople.querySelector('input:checked')) forAll.checked = false; });
  if (forAll) forAll.addEventListener('click', () => { if (forAll.checked) forPeople.querySelectorAll('input').forEach((i) => { i.checked = false; }); });

  // Birthdays and holidays: picking the category makes it yearly, all day, and for everyone, unless
  // someone already chose those. Picking another category undoes only what this did.
  const cat = form.querySelector('[data-category]');
  const auto = { repeat: false, allDay: false };
  if (cat) {
    repeat.addEventListener('change', () => { auto.repeat = false; });
    allDay.addEventListener('change', () => { auto.allDay = false; });
    cat.addEventListener('change', () => {
      const yearly = cat.selectedOptions[0] && cat.selectedOptions[0].hasAttribute('data-yearly');
      if (yearly) {
        if (repeat.value === 'none') { repeat.value = 'yearly'; auto.repeat = true; }
        if (!allDay.checked) { allDay.checked = true; auto.allDay = true; }
        if (forAll && !forAll.checked) { forAll.checked = true; forPeople.querySelectorAll('input').forEach((i) => { i.checked = false; }); updateFor(); }
      } else {
        if (auto.repeat) { repeat.value = 'none'; auto.repeat = false; }
        if (auto.allDay) { allDay.checked = false; auto.allDay = false; }
      }
    });
  }
  form.addEventListener('change', () => { update(); updateAlert(); });
  update();
  updateAlert();
});
