// What can I cook: moods and the Have it all / Missing ≤ 2 / Everything switch apply at once.
// Each place's ingredients fold up: All ticks them, None unticks them and folds the place away,
// and the count beside its name keeps up.
document.querySelectorAll('[data-cook-form]').forEach((form) => {
  const count = (spot) => {
    const boxes = [...spot.querySelectorAll('input[type="checkbox"]')];
    const n = boxes.filter((b) => b.checked).length;
    spot.querySelector('[data-cook-count]').textContent = n === boxes.length ? `All ${n}` : n ? `${n} of ${boxes.length}` : 'None';
  };
  form.addEventListener('change', (e) => {
    if (e.target.matches('[data-auto]')) { form.requestSubmit(); return; }
    const spot = e.target.closest('[data-cook-spot]');
    if (spot) count(spot);
  });
  form.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cook-set]');
    if (!btn) return;
    const spot = btn.closest('[data-cook-spot]');
    const on = btn.dataset.cookSet === 'all';
    spot.querySelectorAll('input[type="checkbox"]').forEach((b) => { b.checked = on; });
    count(spot);
    if (!on) spot.open = false;
  });
});
