// What can I cook: moods and the Have it all / Missing ≤ 2 / Everything switch apply at once;
// "All / none" ticks or unticks a spot's ingredients.
document.querySelectorAll('[data-cook-form]').forEach((form) => {
  form.addEventListener('change', (e) => { if (e.target.matches('[data-auto]')) form.requestSubmit(); });
  form.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cook-all]');
    if (!btn) return;
    const boxes = [...btn.closest('[data-cook-spot]').querySelectorAll('input[type="checkbox"]')];
    const on = !boxes.every((b) => b.checked);
    boxes.forEach((b) => { b.checked = on; });
  });
});
