// Reminder form: shows the people list only for "Choose people", and limits an
// only-me reminder to notifying you or no one.
(function () {
  const form = document.querySelector('[data-notify-form]');
  if (!form) return;
  const people = form.querySelector('[data-people]');
  const priv = form.querySelector('[data-private]');
  const hint = form.querySelector('[data-private-hint]');
  const shared = form.querySelectorAll('[data-shared-only="1"]');
  const radios = form.querySelectorAll('input[name="notify"]');

  function update() {
    const isPrivate = Boolean(priv && priv.checked);
    shared.forEach((l) => { l.hidden = isPrivate; });
    const picked = form.querySelector('input[name="notify"]:checked');
    if (isPrivate && picked && (picked.value === 'all' || picked.value === 'some')) {
      form.querySelector('input[name="notify"][value="me"]').checked = true;
    }
    const now = form.querySelector('input[name="notify"]:checked');
    people.hidden = !now || now.value !== 'some';
    if (hint) hint.hidden = !isPrivate;
  }
  radios.forEach((r) => r.addEventListener('change', update));
  if (priv) priv.addEventListener('change', update);
  update();
})();
