// On every page: (1) a Save button locks and says "Saving…" so a second tap can't save twice,
// with a one-time token the server uses to ignore a repeat that still gets through; (2) an end
// date can't be picked before its start date.
(function () {
  const saved = new WeakMap(); // a locked button's own content (text and any hidden label), to put back
  const token = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const skip = (form) => form.method.toLowerCase() !== 'post' || form.hasAttribute('data-quick') || form.hasAttribute('data-no-lock');

  function prepare(form) {
    if (skip(form)) return;
    let input = form.querySelector('input[name="_once"]');
    if (!input) { input = document.createElement('input'); input.type = 'hidden'; input.name = '_once'; form.append(input); }
    input.value = token();
  }
  document.querySelectorAll('form').forEach(prepare);

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (skip(form) || e.defaultPrevented) return;
    if (form.dataset.sending === '1') { e.preventDefault(); return; }
    form.dataset.sending = '1';
    const btn = e.submitter || form.querySelector('button[type="submit"], button:not([type])');
    // Disable after this tick, so the clicked button's name/value still goes with the form.
    setTimeout(() => {
      form.querySelectorAll('button[type="submit"], button:not([type])').forEach((b) => { b.disabled = true; });
      if (btn && btn.classList.contains('btn') && !saved.has(btn)) { saved.set(btn, [...btn.childNodes]); btn.textContent = 'Saving…'; }
    }, 0);
  });

  // Back/forward cache: a page shown again unlocks, with a fresh token.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    document.querySelectorAll('form[data-sending="1"]').forEach((form) => {
      delete form.dataset.sending;
      form.querySelectorAll('button').forEach((b) => { b.disabled = false; if (saved.has(b)) { b.replaceChildren(...saved.get(b)); saved.delete(b); } });
      prepare(form);
    });
  });

  // End dates: date → endDate, from → to, and a repeat's "until" all start no earlier than the start.
  const PAIRS = [['date', 'endDate'], ['from', 'to'], ['date', 'until']];
  document.querySelectorAll('form').forEach((form) => {
    PAIRS.forEach(([a, b]) => {
      const start = form.querySelector(`input[type="date"][name="${a}"]`);
      const end = form.querySelector(`input[type="date"][name="${b}"]`);
      if (!start || !end) return;
      const sync = () => {
        end.min = start.value || '';
        if (start.value && end.value && end.value < start.value) end.value = start.value;
      };
      start.addEventListener('change', sync);
      sync();
    });
  });
})();
