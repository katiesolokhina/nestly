// Applies a filter as soon as it changes. Without JavaScript, the Filter button still works.
document.querySelectorAll('form[data-auto-submit]').forEach((form) => {
  const button = form.querySelector('button[type="submit"]');
  if (button) button.hidden = true;
  form.addEventListener('change', () => form.requestSubmit());
});
