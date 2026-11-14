// Saves a category color as soon as it's picked. Without JavaScript, the Save color button works.
document.querySelectorAll('[data-color-submit]').forEach((input) => {
  const form = input.form;
  const save = form.querySelector('[data-color-save]');
  if (save) save.hidden = true;
  input.addEventListener('change', () => form.requestSubmit(save));
});
