// Forms marked data-autosave save each change on their own, without reloading: a dropdown when
// it's picked, a text box when you leave it. Buttons that do something else (Archive) still submit.
(function () {
  document.querySelectorAll('form[data-autosave]').forEach((form) => {
    const state = form.querySelector('[data-save-state]');
    const saveBtn = form.querySelector('[data-save-button]');
    if (saveBtn) saveBtn.hidden = true;
    let timer = null;
    let queue = Promise.resolve();
    const show = (text, bad) => {
      if (!state) return;
      state.textContent = text;
      state.classList.toggle('bad', Boolean(bad));
      clearTimeout(timer);
      if (!bad && text === 'Saved') timer = setTimeout(() => { state.textContent = ''; }, 2000);
    };
    const save = () => {
      queue = queue.then(async () => {
        show('Saving…');
        const body = new URLSearchParams(new FormData(form));
        body.delete('action');
        try {
          const res = await fetch(form.getAttribute('action'), { method: 'POST', body, credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
          if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw new Error();
          const data = await res.json();
          show('Saved');
          form.dispatchEvent(new CustomEvent('autosaved', { detail: data, bubbles: true }));
        } catch {
          show('Not saved. Check your connection and try again.', true);
          if (saveBtn) saveBtn.hidden = false;
        }
      });
    };
    form.addEventListener('change', (e) => { if (e.target.matches('select, input, textarea')) save(); });
    // Enter in a one-line box saves instead of submitting the whole page.
    form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input[type="text"]')) { e.preventDefault(); e.target.blur(); } });
  });

  // The tags at the top of a feedback card follow what was saved.
  document.addEventListener('autosaved', (e) => {
    const card = e.target.closest('section');
    const tag = card && card.querySelector('[data-prio-tag]');
    if (!tag) return;
    const p = e.detail.priority;
    tag.hidden = !p;
    tag.className = `tag prio-${p}`;
    tag.textContent = e.detail.priorityName;
  });
})();
