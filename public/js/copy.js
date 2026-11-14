// Copy buttons: shown only where the browser can copy.
document.querySelectorAll('[data-copy]').forEach((btn) => {
  if (!navigator.clipboard) return;
  btn.hidden = false;
  btn.addEventListener('click', async () => {
    const label = btn.firstChild.textContent;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.firstChild.textContent = 'Copied';
    } catch {
      btn.firstChild.textContent = 'Couldn’t copy';
    }
    setTimeout(() => { btn.firstChild.textContent = label; }, 1500);
  });
});
